# Spec: Rust native port of `packages/provider-node`

Status: active. Owner: main session. Written before implementation, per `AGENTS.md:3`.
Extends `docs/specs/rust-native-ports.md` (delivery model + 10 invariants, binding) and
executes the wave-3 provider-node row of `docs/specs/rust-native-program.md` §9.2.

## 1. Goal

Delete `packages/provider-node` (17 TS modules, 1,904 LOC) with **zero JS fallback**: every
responsibility the package owned moves to Rust, consumers are rewired in the same change, and
the TS package directory is removed, not stubbed.

## 2. Boundary decision (what provider-node owned vs what it composed)

`packages/provider-node` contains two kinds of code:

1. **The file/network plane it owns** — this is ported to Rust:
   - `provider-config-file-codec.ts` — strict file schema, version gate, legacy manual-rule
     narrowing, canonical encode. (Already in `zcode-provider-config/src/schema.rs`.)
   - `personal-provider-config-repository.ts` — lock-protected read/update, legacy import,
     recovery-on-invalid, write-generation CAS, 1 s polling invalidation. (Already in
     `zcode-provider-config/src/repository.rs`.)
   - `zcode-builtin-provider-config-source.ts` — bundled/active release selection, atomic
     materialisation, remote-release apply, change events. (`builtin_source.rs`, plus the
     watcher this spec adds — §3.3.)
   - `zcode-builtin-remote-synchronizer.ts` — cross-process lease/cadence control file,
     capped exponential failure backoff. (`remote_sync.rs`.)
   - `endpoint-scoped-zcode-builtin-source.ts` — endpoint-keyed cache paths + per-endpoint
     source/synchronizer swap. (New `endpoint_scoped.rs`, §3.4.)
   - `zcode-builtin-download.ts` — client-config + CDN download boundary: URL construction,
     20 s total budget, 10 MB body cap, schema validation, error taxonomy. (New
     `download.rs`, §3.5.)
   - `zcode-builtin-cache-paths.ts`, `zcode-builtin-provider-config-materializer.ts`,
     `runtime-paths.ts`, `zcode-builtin-release.ts` — pure path/serialisation compute.
     (`cache_paths.rs`, `materialize.rs`, `schema.rs` release codec.)
   - `legacy-reasoning-level.ts` + `legacy-reasoning-level-renames.ts` — the rename table
     and the old-rules rebuild + resolve. (New `legacy_reasoning.rs`, §3.6.)
   - `provider-config-runtime.ts` — runtime orchestration: start ordering, 60 s background
     check (remote refresh + check listeners, `allSettled` error fan-out), refresh routing
     between the plain synchronizer and the endpoint-scoped source. (New `runtime.rs`, §3.7.)

2. **Composition over `@zcode/provider` domain classes** — this is NOT ported; it was never
   provider-node's compute. `ProviderConfigService`, `ProviderRegistryService`,
   `ModelSelectionFacade`, `MutableAccountProviderConfigSource`, the config/resolution domain
   (`ProviderConfigMap`, `ModelConfigRules`, …) all live in `packages/provider`, which stays
   TypeScript until its own wave-3 port. The Node hosts keep using them, fed by **hydration
   adapters** (§4) that re-parse the native snapshot JSON with the exact same
   `parsePersonalProviderConfigMap` / `parsePersonalModelConfigRules` /
   `parseZCodeBuiltinProviderConfigRules` / `parseZCodeBuiltinModelConfigRules` functions the
   deleted TS codec used — byte-identical input, byte-identical domain objects. This is the
   sanctioned `zcode-config` shape ("shared-schema reimplementation"), not a fallback: there
   is exactly one implementation of every provider-node responsibility, and it is Rust.
   - `provider-registry-runtime.ts` disappears entirely: its only content was composing
     `NodeProviderConfigRuntime` + a `ProviderRegistryService` + the fail-closed account
     initialisation. The CLI call site (`process-provider-registry-runtime.ts`) now
     performs that composition inline — config runtime → fail-closed barrier →
     `registryService.start()`, single-flight — over its own account source; services
     `providerRuntime.ts` already expressed it.
   - `model-selection-config-repository.ts` — the fixed "set `defaultModelSelection`"
     transform moves into the native repository as `set_default_model_selection`; the class
     shell becomes a thin wrapper adapter.
   - `model-selection-facade.ts` — the classification table (mirror of `@zcode/shared`'s
     closed 8+2 provider-id set) and the legacy-reasoning resolver are exposed as native
     functions; the wrapper still constructs the `@zcode/provider` `ModelSelectionFacade`
     (that class is `@zcode/provider`'s). `classificationMatchesSharedProviderIds()` in
     the wrapper asserts the native mirror against `@zcode/shared`'s own predicates, so
     the mirror cannot drift silently.

## 3. Rust design

### 3.1 Crates

- `zcode-provider-config` (existing `rlib`) gains the pure/file modules:
  `cache_paths.rs`, `materialize.rs`, `legacy_reasoning.rs`, `endpoint_scoped.rs`,
  `runtime.rs`, `download.rs`. The Tauri host is unaffected (additive API).
- **New `packages/rust/crates/zcode-provider-node`** — `cdylib`, `#[napi]` bindings over the
  rlib, compiled to `packages/rust/zcode-provider-node.<platform>.node` by the existing
  `build:native` pipeline. This is the only Node ABI surface. It enables napi's `async`
  feature (tokio_rt) because the ported boundary awaits injected JS callbacks mid-operation
  (§3.8).

### 3.2 JSON boundary

Following the `zcode-task-index` precedent: structured values cross as JSON strings.
Snapshot JSON carries the **file-form rule JSON** (`providerConfigRules` /
`modelConfigRules`), so the hydration adapters run the identical TS parse functions on the
identical bytes the deleted codec produced. Revisions are computed natively (sha-256 of the
canonical compact encode for personal; `zcode-builtin:<revision>:<sourceKey>` for builtin),
matching the TS strings exactly.

### 3.3 Builtin-source watcher

TS used `fs.watch` on the active file's directory, re-read under the file lock, and emitted
`file-changed` only when the release signature changed (`watch-error` on failure). The Rust
port uses a 250 ms metadata-poll thread with the same lock + signature CAS + dedup contract.
The event contract is preserved; detection latency is bounded at 250 ms instead of ~ms. The
personal repository already uses a 1 s poll for the same purpose, so this matches the
package's own established mechanism. `watch: false` disables it exactly as before.

### 3.4 Endpoint-scoped source

`resolveCurrent` is reproduced: endpoint origin is normalised (trim, http(s)-only,
`url.origin`), cache paths are derived (`runtime/provider/<platform>/<appVersion>/endpoint-
<sha256-32>/`), and when the resolved active path changes the previous source+synchronizer
are disposed and `endpoint-changed` is emitted. Concurrent `ensureCurrent` calls coalesce
into one resolution, as in TS.

### 3.5 Download boundary

The network itself stays injected (the TS `request` callback — services' `ApiClient` or the
CLI's fetch): the port owns the URL construction, init shape (`GET`, `credentials: "omit"`,
`redirect: "error"`), the 20 s total budget (tokio timeout), the 10 MB body cap (checked on
the assembled body; the wrapper enforces the same cap while streaming), the client-config
schema + https-without-credentials refinement on the CDN URL, the retired-ZAPI rejection,
and the exact error strings (`ZCode Built-in <stage>: <reason>` with
`timeout|cancelled|HTTP <status>|empty body|body limit exceeded|invalid schema at <path>|
invalid response`). On timeout the native side additionally fires an abort callback so the
wrapper cancels the in-flight JS request; behaviour observed by callers is unchanged.

### 3.6 Legacy reasoning level

`legacy-reasoning-level.ts` rebuilds the old builtin rules by renaming `disabled` back to the
historic level (`off`/`nothink`) for the 25 exact `modelMatch` entries, then resolves through
the original rule engine. The rlib's `ModelConfigRules::resolve(ResolutionInput)` is the same
engine; the port rebuilds the renamed rules natively and applies the identical guards
(personal exact rule escapes, provider lookup, `disabled ∈ values` check). The rename table
is a const array transcribed 1:1. Input JSON: `{ selection, personalModelRules (file form),
builtinModelRules (file form), providers: [{ providerId, templateId?, apiType?, baseUrl? }]
}`. Output: `"disabled" | null`.

### 3.7 Runtime orchestration (`runtime.rs`)

`NativeProviderConfigRuntime` owns: personal repository, builtin source (plain or
endpoint-scoped), remote synchronizer when applicable, and the 60 s check task.
- `start()`: single-flight; the wrapper performs the TS `ProviderConfigService.read()` first
  (same order as TS: config read before checks), then the native start arms the check task.
- `refreshZCodeBuiltin({force})` routes to the endpoint-scoped source or the synchronizer,
  `"skipped"` when no remote is configured, `"disposed"` after dispose.
- The check task runs `refreshZCodeBuiltin` plus all registered check listeners, settling
  all and forwarding rejections to `onZCodeBuiltinRefreshError` — the TS `allSettled`
  semantics.
- `importLegacy` is invoked with the builtin snapshot JSON, as in TS.

### 3.8 JS-callback interlock

napi's `async` feature (tokio_rt) is enabled for this crate. Injected async JS callbacks
(`importLegacy`, `fetchRelease`, `resolveEndpointKey`, `resolveEndpointOrigin`, `request`,
`update` transforms, check listeners) are `ThreadsafeFunction<Args, Promise<Return>>` and are
awaited with `call_async`. Where a callback must run **inside the file lock** (repository
`update`, legacy import), the lock body runs on a blocking thread and the callback future is
driven to completion there — the JS main thread executes the callback, so no deadlock is
possible. No callback result is cached; every `update` re-reads under the lock first.

### 3.9 napi surface

Constants (`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV`,
`ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV`, `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV`,
`PERSONAL_PROVIDER_CONFIG_FILE_NAME`) plus:

| napi export | Replaces |
| --- | --- |
| `decodeProviderConfigFile` / `encodeProviderConfigFile` | `provider-config-file-codec.ts` |
| `NativePersonalProviderConfigRepository` | `personal-provider-config-repository.ts` |
| `NativeZCodeBuiltinProviderConfigSource` | `zcode-builtin-provider-config-source.ts` |
| `NativeEndpointScopedZCodeBuiltinSource` | `endpoint-scoped-zcode-builtin-source.ts` |
| `NativeProviderConfigRuntime` | `provider-config-runtime.ts` (+ remote synchronizer) |
| `downloadZCodeBuiltinRelease` | `zcode-builtin-download.ts` |
| `materializeZCodeBuiltinProviderConfig` | `zcode-builtin-provider-config-materializer.ts` |
| `resolveZCodeBuiltinCachePaths` / `resolveZCodeBuiltinClientPlatform` / `createZCodeBuiltinEndpointKey` / `normalizeZCodeBuiltinEndpointOrigin` | `zcode-builtin-cache-paths.ts` |
| `resolveNodeProviderRuntimePaths` / `createNodeProviderRuntimePathEnv` | `runtime-paths.ts` |
| `classifyModelProviderKind` | the classification closure in `model-selection-facade.ts` |
| `resolveLegacyReasoningLevel` | `legacy-reasoning-level*.ts` |
| `decodeZCodeBuiltinRelease` / `serializeZCodeBuiltinRelease` | `zcode-builtin-release.ts` |

`ZCodeBuiltinRemoteSynchronizer` is no longer a public class: its only caller was the
runtime, which owns it natively now. `NodeProviderRegistryRuntime` is deleted, not ported
(§2). `NodeModelSelectionConfigRepository`'s transform moves into the native repository;
its class shell is a wrapper adapter.

## 4. TypeScript wrapper (`packages/rust/src/providerNode.ts`)

Thin adapters, same public names as the deleted package, exported via
`@zcode/rust/provider-node`:

- Hydration adapters: native snapshot JSON → `ProviderConfigLayerSnapshot` domain objects
  via `@zcode/provider`'s parse functions (§2).
- `NodePersonalProviderConfigRepository`, `NodeZCodeBuiltinProviderConfigSource`,
  `EndpointScopedZCodeBuiltinSource`, `NodeModelSelectionConfigRepository`,
  `NodeProviderConfigRuntime` — adapter classes implementing the `@zcode/provider`
  interfaces the consumers type against.
- `createNodeModelSelectionFacade` — constructs `@zcode/provider`'s `ModelSelectionFacade`
  with the native classification + legacy-reasoning functions.
- `downloadZCodeBuiltinRelease` — wires the injected `request` and the caller's
  `AbortSignal` to the native boundary (pure forwarding, no logic).
- `@zcode/rust` gains `dependencies: @zcode/provider, @zcode/shared` (hydration only — the
  renderer never imports this subpath; the native-graph gate covers `@zcode/rust` imports).

## 5. Consumer rewiring (same change)

- `packages/services`: `model-provider/{providerConfigRuntime,providerRuntime,
  providerProvisioningSource,providerProvisioningTarget,zcodeBuiltinRemoteConfig}.ts`,
  `node.ts` — import swap to `@zcode/rust/provider-node`; `providerRuntime.ts` composes the
  TS `ProviderRegistryService` directly (it already did for its own runtime class).
- `apps/zcode-cli`: `bootstrap/src/app/process-provider-registry-runtime.ts` (compose
  registry over the native-backed config runtime, incl. the fail-closed account init that
  `NodeProviderRegistryRuntime.start` performed), `bootstrap/src/auth-login.ts`,
  `bootstrap/src/app/standalone-account-provider-runtime.ts`,
  `bootstrap/src/zcode-protocol-entrypoint.ts`, `cli/src/provider-runtime-env.ts`.
- `package.json` of each consumer: `@zcode/provider-node` dep removed, `@zcode/rust` added
  where not present.
- `packages/provider-node/` deleted; removed from any tsconfig reference lists, build
  scripts, and knip/dep inventories that name it.

## 6. Invariants (from rust-native-ports.md, restated where at risk)

1. **Zero JS fallback** — `loadNative` throws when the binary is missing; no
   `try { native } catch { legacy }` anywhere. The legacy TS is deleted in this change.
2. **Legacy paths deleted** — `packages/provider-node` directory removed.
3. **No behavior forks** — the on-disk formats (provider_config.json canonical encode,
   builtin release pretty encode, control-file JSON), the revision strings, the refresh
   cadence/backoff numbers, and every error message are byte-identical; the differential
   tests in §7 prove it against TS-generated fixtures.
4. **Event-loop rule** — every IO-bearing or lock-holding napi method is async.
6. **Abort parity** — download keeps the 20 s budget + caller-signal cancellation;
   synchronizer dispose stops waiting on the fetch (§3.5).
9. **Renderer graph** — `@zcode/rust/provider-node` is consumed only by Node entrypoints
   (services, CLI bootstrap). Zero imports under `packages/shared/src/zcode-protocol-v4/`;
   enforced by `check-native-graph.mjs`.

## 7. Acceptance — actual results (2026-10-03)

- [x] This spec precedes the implementation.
- [x] `cargo build --release -p zcode-provider-node` succeeds; `cargo test -p
      zcode-provider-config -p zcode-provider-node`: **68 tests pass** (cache-path vectors,
      materialise byte output, control-file damage rebuild, endpoint-scoped swap,
      legacy-reasoning rename rows, download error taxonomy with an injected request,
      runtime refresh routing, watcher event contract, import materialisation).
- [x] Differential parity: the built-in release round-trips over
      `tests/_fixture_canonical_builtin.json` (native + wrapper smoke),
      `real_file_parity.rs` passes against the live TS-written personal file, and the
      legacy-import answer lands verbatim through the strict file shape.
- [x] `pnpm --filter @zcode/rust build:native` stages
      `packages/rust/zcode-provider-node.linux-x64-gnu.node` (15 files staged — the
      packaging inventory requires a `@zcode/rust/provider-node` importer, so an unwired
      binary cannot ship).
- [x] Direct-load smoke: `npx tsx scripts/verify-provider-node-port.mts` drives the
      **wrapper** end-to-end over the staged binary — codec round trip through
      hydration, materialise, repository read/update-inside-the-lock/legacy-import/
      poll invalidation, model-selection default, runtime refresh routing + disposed
      semantics, classification parity, dispose. A raw-addon smoke additionally
      exercised the constants, cache paths, subscription fan-out and the download
      two-step with an injected request.
- [x] Byte-boundary smoke not applicable: no `Uint8Array` crosses this boundary (JSON
      strings only) — recorded here as the spec requires.
- [x] Consumers compile against `@zcode/rust/provider-node`; root `pnpm typecheck`
      (10 packages) passes. The documented composition moves landed: the CLI's
      `process-provider-registry-runtime.ts` composes `ProviderRegistryService`
      inline with the single-flight start order (§2), services' `providerRuntime.ts`
      needed no structural change.
- [x] `grep -r "@zcode/provider-node"` yields no references outside this spec and the
      deletion note; `packages/provider-node` is deleted; `pnpm lint` reports **0
      errors** (52 pre-existing warnings, **0 in port files**);
      `pnpm architecture:check --changed` **0 violations**;
      `node packages/shared/scripts/check-native-graph.mjs` OK (1,746 modules).
- [x] Grep proof: no `catch`→legacy shape; the wrapper's loader path has no fallback
      branch.
- Baseline-failing gates, unchanged by this port (verified against a stashed tree):
  `pnpm knip` (732 pre-existing issues — the new `scripts/verify-provider-node-port.mts`
  is flagged exactly like the 18 pre-existing `scripts/verify-*` entries) and
  `pnpm fmt:check` (155 pre-existing files; every file this change touches is
  `oxfmt --check` clean).

## 7.1 Known divergences (documented, tested)

- The builtin-source watcher polls file metadata every 250 ms instead of `fs.watch`
  (~ms delivery). The event contract is identical: lock-held re-read, signature CAS,
  one `file-changed` per real change, `watch-error` on failure — all covered by
  `builtin_source.rs` tests. See §3.3.
- The download boundary enforces the 10 MB cap on the assembled body rather than while
  streaming; an oversized response is still refused before decoding (tested).
- `fetchRelease`'s `AbortSignal` comes from the runtime's controller (aborted on
  `dispose`) instead of one controller per refresh call; the observable cancellation
  point — dispose during an in-flight fetch — is unchanged.
- The classification mirror is asserted against `@zcode/shared`'s predicates by
  `classificationMatchesSharedProviderIds()` in the wrapper smoke, so the closed
  provider-id table cannot drift silently.

## 8. Non-goals

- `packages/provider` (domain classes, `ProviderConfigService`, `ProviderRegistryService`,
  facades) stays TypeScript — wave 3 scope of `rust-native-program.md`, tracked separately.
- The Tauri host's `zcode-provider-config` consumption is unchanged (additive rlib API).
- The desktop-side minimal materialiser in
  `apps/zcode-tauri/src-tauri/src/services/builtin_provider_config.rs` keeps its boot path;
  unifying it with `materialize.rs` is a follow-up, not this change.
