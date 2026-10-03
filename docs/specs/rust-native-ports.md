# Spec: Rust native ports (`@zcode/rust`)

Status: active. Owner: main session. This spec governs every TS↔Rust boundary created by the native-port effort. Per-port specs live next to this file (`rust-native-image.md`, `rust-native-git.md`, `rust-native-diff.md`, …) and are written before their port is implemented.

## Why

Measured bottlenecks (analysis, 2026-09): pure-JS image codecs (1.63 s per 4K JPEG encode, up to 20 re-encodes per image), git refresh storm (3–4 spawned `git` processes + 757 ms numstat per 300 ms watcher flush, ≥1 core busy during agent writes), pure-JS diff/Levenshtein on tool paths (16.6 ms per Edit on a 1.67 MB file with a 5 s synchronous timeout). Rust replaces these with compiled machine-code binaries.

## Delivery model (what "binary, zero JS fallback" means)

- One Cargo workspace at `packages/rust/Cargo.toml`, one crate per port under `packages/rust/crates/<port>/`, each a `cdylib` compiled through `#[napi]` (`napi`/`napi-derive` from crates.io).
- `pnpm --filter @zcode/rust build:native` builds all crates and emits `packages/rust/<crate>.<platform>.node` (platform suffix logic lives in `scripts/build-native.sh` and is mirrored by `nativePlatformTarget()` in `src/loader.ts`; the two must stay identical).
- Consumers load binaries only through `loadNative<T>(crate)` (`packages/rust/src/loader.ts`) via the package subpath exports (`@zcode/rust/image`, `@zcode/rust/git`, `@zcode/rust/diff`).

### Invariants (all binding, no exceptions)

1. **Zero JS fallback.** No `try { native } catch { legacy }` shapes, no environment-flag switches to legacy implementations, no "degraded mode". If the native binary is missing or fails to load, the process throws an actionable error. This is a correctness property, not a style preference.
2. **Legacy paths are deleted, not disabled.** Every port removes the JS implementation it replaces (imports, helper modules, dependencies) in the same change. Obsolete parsers, retry ladders, and spawn helpers that no longer have a caller are removed.
3. **No behavior forks.** Output payloads crossing existing contracts (wire formats, `GitStatusSnapshot`, `DiffHunk[]`, `ImagePrepareForModelResult`, …) are byte/shape-identical to the legacy implementation. Ports change the compute engine only.
4. **Event-loop rule.** Any native operation that can exceed ~1 ms on realistic inputs MUST run as a napi async task (Promise), never a synchronous call on the host/CLI event loop. Short primitives (Levenshtein, single-shot diff) may be synchronous.
5. **Process rule.** The ported feature performs zero child-process spawns. Unported sibling features that are not alternatives to the ported path (e.g. git push/pull/hooks, checkpoint diffs) remain as they are and are documented in the port's spec — they are separate features, not fallbacks.
6. **Abort/cancellation parity.** Where the legacy API accepted `AbortSignal`/timeout semantics, the native path preserves them (checked between work units inside the native ladder, or by racing the async task — the chosen mechanism is documented in the port spec).
7. **Packaging.** `@zcode/rust` is external in `apps/zcode-cli/packages/cli/scripts/build.mjs` (`resolveBuildExternal`) like `koffi`; `.node` artifacts are never inlined by esbuild.
8. **Byte boundary.** Any value crossing the TS↔Rust boundary as _bytes_ is a `Uint8Array` on the JS side. In napi 3 a `Vec<u8>` parameter is bound through `Vec<T>` → `Array::from_napi_value` → `napi_get_array_length`, so it accepts only a real JS `Array<number>` and returns a plain `Array`; passing a `Uint8Array` (what every production caller sends: `TextEncoder`, `subarray`, `VSBuffer.buffer`, socket chunks) fails with `ArrayExpected: Failed to get Array length`, and a returned `Array` breaks the declared `Uint8Array` contract downstream. Byte parameters and byte returns must therefore use napi's `Buffer` (`napi::bindgen_prelude::Buffer`, the type `zcode-image` already uses), which accepts any `Uint8Array`/`Buffer` on input and yields a `Uint8Array`-compatible `Buffer` on output. The correction lives in the native signature only — the fix is never a JS-side `Array.from(...)` shim, which would violate invariant 1 (zero JS fallback) and invariant 3 (no behavior fork). `packages/rust/scripts/smoke-byte-boundary.mjs` is the acceptance gate for this invariant, and it loads **only crates that still exist**: `zcode-codec` (the wire byte path). The four v4-wire byte crates it originally covered (`zcode-buffer`, `zcode-protocol`, `zcode-chunkstream`, `zcode-channel`) were deleted as dead in `6e896ec`; their renderer TypeScript twins under `packages/shared/src/zcode-protocol-v4/` are the single implementation for the platform that cannot host a `.node` (invariant 9 — not a fallback), so there is no byte crossing left there to smoke. The gate's sections for those crates were removed together with them — a gate that loads a deleted crate crashes with `MODULE_NOT_FOUND` and proves nothing. Ports that move bytes through object fields or async returns (`zcode-image`'s `data: Buffer`, `zcode-fs`'s `read_file_range`) discharge invariant 8 in their own port spec's direct-load smoke.
9. **No native in renderer-reachable modules.** A module reachable from the renderer/browser bundle graph must not statically import `@zcode/rust`. The sandboxed renderer cannot load a `.node`; Vite externalizes `node:fs`/`node:module`/`node:path`/`node:url` and the renderer's `loadNative` throws at first use. This is a build-time module-graph rule, not a runtime guard, so it is verified statically:
   - Legal native consumers: Node-only entrypoints — `packages/rpc` (stdio/channel/chunkstream/persistent-protocol), `packages/services` git + event-coalescer surfaces, `apps/zcode-cli` storage/markdown/image, and the desktop **host** (main/host/scheduler).
   - Illegal: anything in `packages/shared/src/zcode-protocol-v4/**` that the renderer imports by value, because the renderer imports that barrel for runtime values (`TopicWireFrameAssembler`, `applyConversationDeltas`, `parseConversationTopic`, `PROTOCOL_V4_LIMITS`, …).
   - The eight affected modules (`wire-binary`, `wire-codec`, `wire-assembler`, `wire-reassembly`, `apply`, `coalesce`, `profiles`, `workflow-runs-delta`) therefore keep their pure-TypeScript implementations. They are **not** a "fallback": they are the single implementation for a platform that cannot host a native binary, while native stays the single implementation for the Node-only consumers above. Restoring their `HEAD` bodies reverts an unmerged in-flight edit rather than forking behavior.
   - Gate: `node packages/shared/scripts/check-native-graph.mjs` must report zero `@zcode/rust` imports under `packages/shared/src/zcode-protocol-v4/`. If a future port wants these hot paths in Rust, the correct shape is a Node-only subpath plus a renderer-safe barrel, never a runtime `try { native } catch { js }` branch.
10. **Measure before binding a native port; only port the primitives that win.** A napi call carries a fixed cost that must be smaller than the primitive's own work, or the port is a regression. Measured on this repo's i5-8500 host: floor for a number→number call **0.095 µs**; an owned `Buffer` parameter adds **~0.12 µs** (`napi_create_reference` per call); a borrowed `&[u8]` / `Uint8ArraySlice<'_>` parameter adds only **~0.05 µs**, and returning the same owned `Buffer` you received costs **~0.19 µs** (no copy). `@zcode/rpc` models this as a byte port (`packages/rpc/src/bytes-port.ts`) with exactly one deterministic binding per platform — Node entrypoints bind `@zcode/rpc/native`, the renderer keeps the platform binding, and there is no runtime fallback switch (invariant 1).

- **Ported: `crc32Hex` → Rust `crc32fast`** (x86-64 CRC32 instruction, slicing-by-8 fallback). The historical TS loop shifted bit-by-bit (8 iterations per byte) and cost 2.19 ms on a 64 KB frame. The table-driven JavaScript replacement is ~11x better than that and still ~66x slower than Rust: **28x at 4 KB, 66x at 64 KB, 73x at 1 MB** (3.07 ms → 42 µs). Output is byte-identical.
- **Not ported, and not portable: `base64*`, `vql*`, `alloc`, `slice`, `concat`.** Their work is at or below the FFI floor, so no amount of Rust tuning wins:
  - `vqlRead` decodes 1–2 bytes. TS does it in 0.02 µs; the napi floor alone is 0.095 µs. A Rust win is arithmetically impossible, and the tuple return (a JS array allocation) makes it worse.
  - `base64` — `base64` 0.23 keeps its AVX2 engine on the separate `base64::engine::Avx2` type behind a runtime CPU check; `general_purpose::STANDARD` is the **scalar** engine even with `simd-unsafe` on. Using the real AVX2 engine took a 64 KB encode from 49.7 µs to 27.4 µs, but that is still 0.83x Node's built-in C++ codec (and only 1.27x ahead at 1 MB), so it stays on the platform.
  - `alloc` / `slice` / `concat` are bounded by V8's already-optimal zeroed allocation and memcpy.
  - Batching is not a workaround: `base64EncodeBatch` over 64 × 4 KB measured 0.38x (slower) because every element of a `Vec<Buffer>` still pays the reference cost.
- Gates: `packages/rpc/scripts/check-bytes-port-parity.mjs` asserts the two bindings are **byte-identical** (125 checks, including a length sweep and the ISO 3309 vector for CRC32) — the two must never disagree on wire bytes. It has already caught real defects: a broken slicing-by-4 CRC32, and `slice` / `read_uint32_be` panicking and aborting the process on out-of-range input in `zcode-buffer`. `packages/rpc/scripts/bench-bytes-port.mjs` produces the table; re-run it before changing any binding.
- The rule for any future port: native wins on _full-payload compute_ (image, diff, git, markdown, event store — all Node-only and already ported), never on sub-microsecond byte primitives. When a port does not win, fix the TypeScript (table-driven CRC32 here) rather than pushing the work to Rust.

## Ownership

| Area                                                                                                                                                                                                                              | Owner             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `packages/rust` shared files: `Cargo.toml`, `package.json`, `tsconfig.json`, `src/loader.ts`, `src/index.ts`, `scripts/build-native.sh`, this spec, `architecture-policy.yaml` entry, `resolveBuildExternal`, root typecheck list | main session      |
| `packages/rust/crates/<port>/**`, `packages/rust/src/<port>.ts`, that port's spec file                                                                                                                                            | that port's agent |
| Consumer integration files + consumer `package.json` of that port                                                                                                                                                                 | that port's agent |

Cross-boundary signature changes: the owning agent does not edit shared files; it requests the change over IRC from the main session.

## Acceptance (per port, checked before merge)

- Spec file exists and precedes implementation (git history order).
- `cargo build --release -p <crate>` succeeds; `build:native` emits the `.node`.
- Direct-load smoke: `node -e` loads the `.node` and exercises the API (evidence in report).
- Byte-boundary smoke: `node packages/rust/scripts/smoke-byte-boundary.mjs` passes. The gate covers every remaining crate whose signature moves bytes on the wire path (`zcode-codec`); byte-moving crates covered by their own port specs — `zcode-fs` `read_file_range` (`rust-native-fs.md` §3.6), `zcode-image` `data: Buffer` — discharge invariant 8 there (invariant 8).
- Grep proofs: legacy import/spawn/ladder gone; no `catch` → legacy shape.
- Renderer-graph gate: zero `@zcode/rust` imports under `packages/shared/src/zcode-protocol-v4/` (invariant 9), asserted by `packages/shared/scripts/check-native-graph.mjs`.
- Consumer typecheck + `pnpm lint` + `pnpm architecture:check --changed` report no NEW violations in this port's files.
- Wire/contract shapes unchanged (existing consumers compile without edits beyond the import swap).

## Migration boundary / non-goals (wave 1 + wave 2)

- Wave 1 (active): image prepare/resize codecs, git refresh surface (status + numstat + branch comparison + untracked stats), structured diff + edit-fuzzy primitives.
- Wave 2 (active): rusqlite-backed session event store (`rust-native-events.md`), native markdown parse at the frame producer (`rust-native-markdown.md`), packaging of `.node` binaries into desktop/SEA artifacts (`rust-native-packaging.md`).
- Out of scope, explicitly NOT fallbacks: git push/pull/fetch/hooks/clone/config (separate features, still CLI), checkpoint diffs (separate feature), non-native media metadata sniffing, renderer-side React work (no `.node` in the sandboxed renderer — by Electron design).
- Deferred: Electron/Shell-level replacement (Tauri), full agent-runtime port.
