# Native Boundary Specification: `zcode-diff-wasm` Line Diff / LCS Kernel

## Overview

Two JavaScript implementations of line-level LCS run on the **renderer main thread** and freeze the
UI on large files:

- `buildUnifiedDiff` — `packages/ui/src/lib/toolDiffPreview.ts:337`, backing the full unified-diff
  patch shown in the tool-call diff viewer, the `@`-file-summary cards and the code viewer.
- `computeLineChangeStat` — `packages/shared/src/lineChangeStat.ts:20`, backing the `+N -M` counters
  on edit cards and the task-change summary.

They are **divergent implementations of the same dynamic program** (a 2-D full-table DP and a
rolling-1-D DP), with different safety caps, and both **silently return wrong results** once those
caps fire.

This spec moves the DP into a Rust WASM kernel (`zcode-diff-wasm`) that the renderer loads and calls
**synchronously**, so the existing synchronous render path is preserved. It authorizes **no
JavaScript fallback**: the kernel is the only diff implementation.

### Measured starting state (verified against the checkout)

| Property                     | Value                                                                                                                              | Evidence                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Patch builder                | full 2-D LCS table, `(n+1)×(m+1)` numbers                                                                                          | `toolDiffPreview.ts:272-286`                    |
| Patch builder cap            | `MAX_DIFF_LCS_CELLS = 60_000`, above which it degrades                                                                             | `toolDiffPreview.ts:3,267`                      |
| Stat builder                 | rolling 1-D LCS over the trimmed middle                                                                                            | `lineChangeStat.ts:68-80`                       |
| Stat builder cap             | `MAX_LCS_CELLS = 400_000`, above which it degrades                                                                                 | `lineChangeStat.ts:1,64`                        |
| Degrade behavior (patch)     | delete-all + add-all **unless** unique-anchor pre-split finds anchors                                                              | `toolDiffPreview.ts:215-250`                    |
| Degrade behavior (stat)      | returns total line counts as if nothing matched                                                                                    | `lineChangeStat.ts:64-66`                       |
| Call sites (render thread)   | `codeViewer.ts:477,510`, `fileSummaries.ts:215`, `fileSummaryHeuristics.ts:299,301`                                                | `toolDisplay.ts:254` → `ToolCallBlocks.tsx:187` |
| Stat call sites (both sides) | `packages/services/src/session/taskChangeSummary.ts:57,118` (Host) + `packages/ui/src/lib/taskChangeSummary.ts:120,179` (renderer) | grep `computeLineChangeStat`                    |
| Tests for either path        | **zero**                                                                                                                           | no `.test.ts` references either function        |

The two "freeze" comments are the team's own record of the problem:

- `toolDiffPreview.ts:385-388`: "大文件（如 1500+ 行 Dockerfile）点展开时会在主线程做大量无效字符串拼接，导致界面卡死"
- `lineChangeStat.ts:58-66`: "超大文件如果强行算完整 LCS，会让列表和消息面板明显卡顿"

### Why the boundary is the renderer, and why WASM (measured, not assumed)

`buildUnifiedDiff` is **synchronous** and is called from React render:

```
ToolCallBlocks.tsx:187  useMemo(() => buildToolDisplayModel(toolCall, workspacePath), ...)
  └─ toolDisplay.ts:254  buildToolDisplayModel → getToolCallCodePreview
       └─ codeViewer.ts:477,510  buildUnifiedDiff(...)
```

Two facts settle the boundary:

1. `packages/ui` is a **Vite browser bundle** (`packages/desktop/vite.config.ts:55` aliases
   `packages/ui/src` into the renderer build). A napi `.node` addon **cannot load** there, so a
   Host-side addon cannot serve a synchronous render-time call.
2. Every RPC service method is **async** (`packages/services/src/file/file.ts:21-80`;
   `ProxyChannel.toService` returns async wrappers, `packages/rpc/src/proxy-channel.ts:136-140`).
   Routing the diff over RPC would force these render call sites async, and would race the lazy
   `snapshotRefs` tool-field backfill (`packages/ui/src/lib/taskChatMessageTypes.ts:34`).

Therefore the kernel is **WASM, loaded synchronously in the renderer**. The wasm-bindgen `web`
glue already ships an `initSync({ module })` export that performs `new WebAssembly.Module` +
`new WebAssembly.Instance` (see `pkg/web/zcode_score_web.js:205-217` for the sibling crate), so the
kernel can be compiled once and then called synchronously on every render.

---

## 1. Product rules

1.1 The kernel is the **only** line-diff/LCS implementation. There is no JS LCS on this path and no
degraded mode. If the artifact is missing or `initSync` has not run, the facade **throws** — it never
silently computes the diff in JavaScript. (Same rule as `workspaceScanNative.ts`: "no JS fallback".)

1.2 **One LCS, two views.** `buildUnifiedDiff` and `computeLineChangeStat` are the same dynamic
program over the same inputs. The kernel computes it **once** and returns both the patch and the
`{added, removed}` counts, so the two can never drift again.

1.3 **A diff is a string result, not a behavior change.** For any input under the safety ceiling
(§1.5) the produced patch must be **byte-identical** to today's `buildUnifiedDiff`, and the counts
must equal today's `computeLineChangeStat`. The differential harness (§4) proves this against a
preserved copy of the removed JavaScript.

1.4 **The caps are removed, not ported.** The JS caps (`60_000`, `400_000`) existed only to bound
main-thread freeze; native DP removes that reason. Both caps go away. This is a **correctness
improvement**: inputs that used to degrade (wrong hunks / wrong counts) now produce the true diff.

1.5 **One safety ceiling remains, as a valve not a fork.** Above a single high cell count
(`MAX_DIFF_CELLS`, §2) the kernel falls back to the **unique-anchor pre-split** path
(`toolDiffPreview.ts:215-250`, ported verbatim) so a pathological input cannot allocate an enormous
table. The anchor path is the same algorithm the current 60k fallback already uses; it is
deterministic and, where it fires today, byte-compatible with today's output.

1.6 **Synchronous at call time.** After a one-time preparation, `diffUnified` is a synchronous
`string → string/number` call. No promise crosses into React render.

1.7 **`@pierre/diffs` `trimPatchContext` stays in TypeScript.** It is a string hunk
post-processor, not an LCS (it does not reintroduce O(n·m)). The Rust side returns the **un-trimmed**
patch; the TS wrapper applies context trimming only when the caller asked for a context limit. This
keeps `fileLabel` and presentation concerns in TS.

---

## 2. State ownership

```text
packages/ui/src/lib/diffWasm.ts   (the only owner of the kernel instance)
  ├── kernel: WebAssembly instance            ← created once by initSync(bytes)
  ├── prepared: boolean                       ← false until prepareDiffKernel() resolves
  └── bytes: the staged _bg.wasm payload      ← Vite `?url` asset, fetched once at boot
             │
             ▼  diffUnified(before, after, fileLabel, contextLines)   [synchronous]
        { patch: string, added: number, removed: number }
```

The kernel is **stateless across calls**: unlike `zcode-score-wasm`'s arena there is no retained
per-index state, because a diff is a pure function of its arguments. Exactly one instance exists per
renderer; `prepareDiffKernel()` is idempotent.

`MAX_DIFF_CELLS` (safety ceiling) lives in Rust and is mirrored as a documented constant in the spec
and in a Rust unit test. The threshold chosen is **4,000,000 cells** — comfortably above the old
`400_000` stat cap (so the stat path never takes the anchor route for ordinary files) and far below
the point where a `Vec<u32>` table would threaten renderer memory (4M cells × 4 B = 16 MB).

---

## 3. Interface

```rust
/// Compute the line diff once and return both views.
///
/// `before` / `after` are the raw file texts (the caller has already handled the
/// null-before / created-file / deleted-file cases by passing ""). `file_label` is the
/// path leaf used in the `diff --git a/<label> b/<label>` header; Rust only concatenates
/// it, the caller owns its derivation.
///
/// `context_lines < 0` means "no context limit": the caller wants the full patch and
/// will not run trimPatchContext. `context_lines >= 0` is echoed so the caller can trim.
///
/// Returns the UN-trimmed patch plus the +/- counts computed from the same LCS.
#[wasm_bindgen]
pub fn diff_unified(
    before: &str,
    after: &str,
    file_label: &str,
    context_lines: i32,
) -> DiffResult;

/// One-time synchronous initialisation with the module bytes.
/// Exported by the wasm-bindgen `web` glue; the facade calls it, not the kernel.
// (initSync is generated, not hand-written; listed here for interface completeness.)
```

`DiffResult` carries `patch: String`, `added: u32`, `removed: u32`.

The TS facade (`packages/ui/src/lib/diffWasm.ts`) exposes:

```ts
export function prepareDiffKernel(wasmUrl: string): Promise<void>; // called once at renderer boot
export function diffUnified(
  before: string,
  after: string,
  fileLabel: string,
  contextLines: number,
): DiffResult; // synchronous; throws if not prepared
```

---

## 4. Acceptance scenarios

- **S1 — patch parity.** For every case in the corpus, the kernel's `patch` is byte-identical to the
  preserved JS oracle's `buildUnifiedDiff`. Cases include: create (`before=""`), delete
  (`after=""`), both empty, single-line, no trailing newline, CRLF, multi-byte UTF-8, an SQL `--`
  body line (the `---` header hazard documented at `toolDiffPreview.ts:371-373`), and inputs on both
  sides of the old `60_000` cap.
- **S2 — stat parity.** For every case, `{added, removed}` equals the oracle's
  `computeLineChangeStat`, including the inputs that used to exceed the old `400_000` cap (where the
  oracle is _wrong_ and the kernel is _right_ — S2 asserts the kernel against the true LCS, and
  documents the divergence where the oracle degraded).
- **S3 — both views agree.** `added`/`removed` are derived from the same DP the patch used.
- **S4 — no fallback.** With the artifact absent or `prepareDiffKernel` not called,
  `diffUnified(...)` **throws**; it never returns a JS-computed diff.
- **S5 — context trimming is TS-only.** With a context limit, the returned patch equals
  `trimPatchContext(kernelPatch, n)`; with no limit, the returned patch is the kernel patch verbatim.
- **S6 — no dead JS LCS.** No `appendDiffBodyWithLcs` / `appendDiffBodyWithLargeSegmentFallback` /
  `collectUniqueLineMatches` / `findIncreasingAnchorMatches` / `MAX_DIFF_LCS_CELLS` /
  `MAX_LCS_CELLS` symbol remains in `packages/ui/src` or `packages/shared/src` (grep guard).

---

## 5. Removed in this change

| Removed                                                    | Location                                         |
| ---------------------------------------------------------- | ------------------------------------------------ |
| `appendDiffBodyWithLcs` (2-D DP)                           | `packages/ui/src/lib/toolDiffPreview.ts:252-327` |
| `appendDiffBodyWithLargeSegmentFallback` (anchor)          | `toolDiffPreview.ts:215-250` (moved to Rust)     |
| `collectUniqueLineMatches` / `findIncreasingAnchorMatches` | `toolDiffPreview.ts:133-213` (moved to Rust)     |
| `appendDiffBody` / `MAX_DIFF_LCS_CELLS`                    | `toolDiffPreview.ts:3,329-335`                   |
| rolling 1-D LCS + `MAX_LCS_CELLS`                          | `packages/shared/src/lineChangeStat.ts:1,64-86`  |

Both JS LCS bodies are preserved **verbatim** as the differential oracle in
`packages/desktop/zcode-diff-wasm/harness/legacy_js_diff.mts`.

## 6. Retained fallbacks (explicitly NOT removed)

- `trimPatchContext` (`@pierre/diffs`) — string post-processor, stays in TS (§1.7).
- The extractors in `toolDiffPreview.ts` (`extractBeforeAfter`, `extractStructuredDiff`) — JSON
  shape handling, unrelated to the DP.
- `packages/shared/src/workspaceFileSearch.ts` — the scoring oracle, untouched by this slice.

## 7. Deferred

- **Streaming tool-input preview** (`packages/shared/src/streaming-tool-input-preview.ts`) reuses
  this diff kernel for its per-chunk full-content recovery; it is not wired here.
- **Wiring `zcode-score-wasm`'s `web` artifact** — a separate slice; this change introduces its own
  web artifact and does not touch the score boundary.

## 8. Governance note

`packages/desktop/zcode-diff-wasm` is outside every module root in `architecture-policy.yaml`
(exactly like `zcode-scan` and `zcode-score-wasm`), so `pnpm architecture:check` cannot guard it.
This spec plus the S1–S6 scenarios are the control, and
`.github/workflows/zcode-workspace-file-native.yml` runs the parity harness and the S6 grep guard on
demand.

## 9. Rollback

One revertable commit per step (crate → prepare script → facade → call-site swap → JS deletion). The
two JS implementations are deleted only in the final commit, so every intermediate state builds and
runs; reverting the whole slice restores today's synchronous JS path.
