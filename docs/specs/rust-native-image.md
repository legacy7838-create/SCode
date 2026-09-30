# Spec: Rust native image port (`zcode-image`)

Status: active. Parent spec: `docs/specs/rust-native-ports.md` (all invariants there are binding here). This spec defines the image prepare/resize port.

## Why

The agent's image pipeline (`apps/zcode-cli/packages/adapters/src/image/`) is pure JS via `jimp`. Measured: a 4K JPEG encode takes ~1.6 s and the budget ladder re-encodes the same RGBA buffer up to 20 times per image; transient RAM peaks around ~33 MB RGBA per decode clone. Vision attachments, screenshots and PDF rasterization pay this on every model call. Rust replaces the compute engine (decode/resize/encode ladder); the `ImageProcessorPort` contract in `apps/zcode-cli/packages/contracts/src/interfaces/image-processor.port.ts` is unchanged.

## Boundary

- **Rust side** (`packages/rust/crates/zcode-image`): media-type sniffing, decode (PNG/JPEG/GIF/BMP/TIFF), RGBA8 working buffer, bicubic resize, encode (PNG best-deflate, JPEG via mozjpeg quality ladder, GIF/BMP/TIFF), the full `findFirstFittingCandidate` ladder and budget math, WebP passthrough/unsupported policy. Exposed as two napi async tasks (`prepareImageForModel`, `resizeImageToFit`) plus an `ImageCancelHandle` class. Runs on the libuv thread pool — never on the event loop (parent invariant 4).
- **TS side** (`packages/rust/src/image.ts`): typed wrapper over `loadNative("zcode-image")`, no logic.
- **Consumer** (`apps/zcode-cli/packages/adapters/src/image/index.ts`): implements `ImageProcessorPort` by delegating to the native API; maps native error markers to `ImageProcessorPortError`; wires `AbortSignal` → `ImageCancelHandle.cancel()` and re-checks the signal before dispatch and between the promise race. `create-app.ts` swaps `createJimpImageProcessorAdapter` for `createImageProcessorAdapter`.

## Deleted legacy (parent invariant 2, same change)

`jimp-compression.ts`, `jimp-media.ts`, `image-budget.ts`, `webp-passthrough.ts` are deleted; the `jimp` dependency is removed from `apps/zcode-cli/packages/adapters/package.json`. There is no JS image ladder left anywhere — if the `.node` binary is missing, `loadNative` throws (parent invariant 1). `detectImageMediaType` in `@zcode/contracts` stays: it has callers outside the image adapter (`core/src/tool/handlers/bash-image-output.ts`).

## Behavior parity (parent invariant 3)

- The candidate ladder, its ordering, strategy names (`original`, `preserve-format`, `png-optimized`, `png-quantized` unreachable, `resized`, `jpeg-quality`, `jpeg-fallback`), quality steps (80/60/40/20), progressive scales (0.75/0.5/0.25), aggressive edges (1000/800/600/400/300/200), budget math (`raw ≤ maxRawBytes`, `ceil(n/3)*4 ≤ maxBase64Bytes`, token check), result fields and error codes (`empty`, `invalid_request`, `processing_failed`, `too_large`, `unsupported`) are ported 1:1 from the deleted TS implementation.
- WebP policy preserved exactly: `prepareForModel` passes WebP through when it fits the budget, otherwise throws `unsupported`; `resizeToFit` passes WebP through untouched. This is product behavior, not a fallback.
- `resizeToFit` keeps legacy error shapes: plain `Error` for invalid `maxDimension` ("Image resize maxDimension must be a positive finite number"), raw error on decode failure, plain `Error("Image resize was cancelled")` on abort. `prepareForModel` keeps throwing `ImageProcessorPortError`.
- Abort/cancellation (parent invariant 6): the adapter creates an `ImageCancelHandle` per call and cancels it from the `AbortSignal`; the native ladder checks the flag between every encode/resize step and stops with an `aborted` marker, which the adapter maps to the legacy cancelled error. The adapter also re-checks the signal synchronously before starting.
- Pixel-level note: the resize kernel is cubic (`image` crate CatmullRom) and compressors are mozjpeg/`png`-crate instead of Jimp's encoders, so encoded bytes may differ from Jimp output for the same input. Contract-level outputs (dimensions, media types, strategies, budget fit, error codes) are identical. No consumer inspects raw encoded bytes.

## Error transport across the boundary

Native errors are napi `Error`s whose message starts with `zcode-image:<code>:<message>` where `<code>` is a port code or `aborted`. The TS adapter parses the prefix; unknown codes map to `processing_failed` with the original as `cause`.

## Packaging

`zcode-image.<platform>.node` is emitted by `scripts/build-native.sh` (existing). `@zcode/rust` is already in `resolveBuildExternal()` in `apps/zcode-cli/packages/cli/scripts/build.mjs` — esbuild never inlines the `.node`. No new external entries.

## Acceptance

- `cargo build --release -p zcode-image` + `pnpm --filter @zcode/rust build:native` emit the binary.
- Direct-load smoke via `node -e` on a generated PNG and JPEG exercising: original passthrough, resize+JPEG ladder, WebP passthrough, `too_large`, `aborted`, `empty`.
- Grep proofs: no `jimp` import/dependency in `apps/zcode-cli`, no `try { native } catch { legacy }` shape.
- `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed` with no new violations.
