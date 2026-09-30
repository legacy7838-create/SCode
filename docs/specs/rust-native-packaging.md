# Rust native port: `.node` packaging (`zcode-packaging`)

Status: active. Owner: PackagingSpecAuthor (wave-2 port). Written 2026-09-30 **before** any
implementation code, per the umbrella spec's wave-2 entry (`docs/specs/rust-native-ports.md:47`,
which names this file), `AGENTS.md:3`, and the architecture-governance rule ("Write or update the
spec before implementation … state the behavior, ownership, invariants, failure semantics, and
migration boundary", `.agents/skills/architecture-governance/SKILL.md:14`); explicit time at `:19`;
diagrams for state/timing per `AGENTS.md:44`).

This wave delivers **only this file**. No crate, script, or build-chain change exists yet.

---

## 0. Naming reconciliation: what "packaging" means here

"Packaging" is overloaded in this repo. Three distinct things are called it, and only the third is
this port:

| Thing | Interface | Where | Verdict |
|---|---|---|---|
| Cargo → `.node` emission | `scripts/build-native.sh` | `packages/rust/scripts/build-native.sh:9-14` (target→suffix table), `:21` (crate glob), `:30` (crate-type grep), `:45` (copy) | **In scope, moves to Rust.** It is the only place that knows the artifact naming contract, and it is duplicated in TS. |
| Runtime binary resolution | `loadNative()` / `nativePlatformTarget()` | `packages/rust/src/loader.ts:76`, `:34-51`; candidate paths `:55-70` | **Stays TS, but stops deciding.** It must keep using `require()` (a JS-only primitive), so it cannot be Rust. What *can* move is the suffix table it switches on: that becomes generated from Rust (§4.3). |
| Shipping binaries inside a distributable | desktop installer, SEA single-file binary | `prepare:runtime-assets.mjs:29-34`, `sea-tui-assets.mjs:288-291`, `electron-builder.config.js:593-618` | **The actual gap. In scope, owned by Rust** (§4.2). |

The umbrella spec already anticipated the consumer half — `loader.ts:59-60` documents a
"staged layout (desktop agent bundle / SEA extraction): `native/` next to the entry" candidate that
**nothing in the repository produces**. This port implements the producer for that contract.

---

## 1. Motivation (measured evidence)

All figures below are from this checkout, 2026-09-30.

**1.1 No build step produces or stages a `.node` file.** The desktop build chain is
`build` → `prepare:runtime-assets` → `run-production-build.mjs`
(`packages/desktop/package.json` scripts). `prepare-runtime-assets.mjs:29-34` enumerates exactly
four local runtime scripts — `prepare:agent-bundle`, `prepare:native-search`,
`prepare:browser-import-helper`, `prepare:macos-window-bounds` — and **none of them touches
`packages/rust`**. `rg -n "packages/rust|@zcode/rust|zcode-events" packages/desktop/` matches only
`package.json:47` (the dependency), `tsup.config.ts:169-172,232-234,265` (wrapper inlining), and
zero staging code. `electron-builder.config.js`'s `afterPack` (`:593-618`) runs asar injection,
sourcemap stripping, a native-resource policy assert, and a node-pty prebuild assert — no Rust
assert.

**1.2 The agent-bundle comment is now false.**
`packages/desktop/scripts/prepare-agent-node-bundle.mjs:7` states: *"The agent does not have any
native NAPI plug-ins (ripgrep is WASM, the rest is pure JS) and can run directly on Electron's Node."*
The agent CLI now depends on seven `.node` binaries (§1.4). The comment is the fossil of the
pre-port assumption, and it is why nobody noticed the gap.

**1.3 SEA structurally cannot copy the binaries.**
`sea-tui-assets.mjs:288-291` handles workspace packages with an allowlist of
`package.json` + `dist/**`. `@zcode/rust` is a workspace package whose payload *is*
`packages/rust/*.node` at the package root, not under `dist/`. The allowlist returns `false` for
every `.node`, so even if the binaries existed, SEA would drop all of them. No JS-side fix is
proposed here — the branch is replaced by the Rust-owned staging (§4.2, §6.2).

**1.4 Only 7 of 17 shipped-shaped binaries have a consumer.** Measured by resolving every
`@zcode/rust/*` subpath import in `packages/rust/package.json:6-24` against the whole tree
(excluding `node_modules`, `dist`, `packages/rust` itself, and docs):

| Crate | Live consumer | `.node` size (linux-x64-gnu) |
|---|---|---|
| `zcode-git` | `packages/services/src/git/repo/gitCliRepo.ts` | 4 878 KB |
| `zcode-events` | `adapters/src/storage/session-store/sqlite-session-store.ts`, `…/migration-runner.ts` | 3 046 KB |
| `zcode-markdown` | `apps/zcode-cli/packages/tui/src/app-markdown.tsx`, `…/md-smoke.mts` | 2 839 KB |
| `zcode-image` | `adapters/src/image/index.ts` | 2 199 KB |
| `zcode-codec` | `packages/rpc/src/native/bytes-port-native.ts` | 850 KB |
| `zcode-diff` | `core/src/tool/diff.ts`, `core/src/tool/edit-matchers.ts` | 472 KB |
| `zcode-event-coalescer` | `services/src/zcode-agent/zcodeSessionEventCoalescer.ts` | 473 KB |
| **live subtotal** | | **14 757 KB** |
| `zcode-assembler`, `zcode-buffer`, `zcode-channel`, `zcode-chunkstream`, `zcode-coalesce`, `zcode-profiles`, `zcode-projection`, `zcode-protocol`, `zcode-reassembly`, `zcode-rpc-utils` | **none** | **5 072 KB** |
| **total** | | **19 830 KB** |

The ten zero-consumer crates are the v4-protocol / RPC-wire family that umbrella invariant 9
deliberately keeps on TypeScript, because the sandboxed renderer cannot load a `.node`
(`rust-native-ports.md:24-29`). They are *built but unwired*, not fallbacks. Under invariant 2
("legacy paths are deleted, not disabled") and ordinary payload hygiene, **they must not be
shipped**. Blindly staging `crates/*` would add 5 MB of dead weight to every installer for every
one of the six supported platforms.

**1.5 Consequence.** Because umbrella invariant 1 forbids a JS fallback and `loadNative()`
(`loader.ts:76-84`) *throws* when no candidate path exists, a packaged build produced today does
not degrade — it fails at runtime on the first `git`, `diff`, `image`, `events`, `markdown`, or
`codec` call. The failure is late (user-visible, in the shipped app) and its message names a
missing file rather than a build step, which is the worst possible diagnostic.

**1.6 The distribution smoke test does not check for it.**
`scripts/zcode-distribution-smoke.mjs:1` says it runs *"to avoid dev machine node_modules masking
missing TUI/**native**/worker dependencies"* — but the word `native` appears nowhere else in the
file, and `scripts/zcode-distribution/*.mjs` contains no `.node` handling. The stated intent has no
implementation.

---

## 2. Scope

### 2.1 Ported (crate `zcode-packaging` + build-chain wiring)

- A Rust **binary** crate in the existing workspace that owns the whole naming + staging +
  verification contract (§4).
- The target→suffix table, replacing the bash table at `build-native.sh:9-14` **and** the
  hand-maintained duplicate in `loader.ts:34-51`.
- The cdylib/rlib classification, replacing the `grep` on `Cargo.toml` at `build-native.sh:30`.
- Emission of `<crate>.<suffix>.node` from `target/release/`, replacing the copy loop at
  `build-native.sh:21-46`.
- Staging of the **live** binary set into (a) the desktop agent bundle's `native/` directory and
  (b) the SEA asset tree.
- Verification of a staged tree against a recorded plan (existence, size, sha256, and absence of
  unexpected binaries).
- Code generation of the TypeScript suffix table consumed by `loader.ts`.

### 2.2 NOT ported (siblings / non-goals — separate features, never fallbacks)

- **`loadNative()` itself.** It calls `require()` on a `.node`; that is a JS primitive with no
  Rust equivalent, and the module must be importable *before* any binary is present (importing it
  must never throw — see `loader.ts:16-18`). It stays TypeScript and keeps its "throws, never
  degrades" contract unchanged.
- **The ten zero-consumer crates.** They are neither packaged nor deleted by this port; deletion is
  a separate change under invariant 2 (§9, D1). This port's job is to *not ship* them.
- **`zcode-rpc-server`** — the one `rlib` crate (`crates/zcode-rpc-server/Cargo.toml`), linked
  directly into the Tauri host and emitting no shared object. `build-native.sh:25-33` already
  documents this; the Rust tool classifies from Cargo metadata instead of grepping, so the case
  stops being a special case.
- **Cross-compilation.** Building a `darwin-arm64` binary on a Linux CI worker is a separate
  capability (toolchains, codesign, `lipo`). This port consumes already-built artifacts per target
  and verifies them; it does not produce cross-platform builds.
- **Code signing / notarization** of the `.node` files, and the Tauri/Electron signing stories in
  `apps/zcode-tauri/PORT_STATUS.md`. Out of scope.
- **The renderer's TS twins** of the ten unwired crates. Untouched; umbrella invariant 9 owns them.

### 2.3 Sync vs async decision

Not applicable — `zcode-packaging` is a build-time CLI, not a runtime library. It performs no work
inside any event loop and ships no `.node` of its own (it is `crate-type = ["bin"]`, deliberately
**not** `cdylib`, so it can never be picked up by the emission loop it replaces).

### 2.4 Ownership

| Piece | Owner |
|---|---|
| `packages/rust/crates/zcode-packaging/**`, this spec file | PackagingSpecAuthor |
| `packages/rust/scripts/build-native.sh` (reduced to a shim), `packages/rust/src/loader.ts`, generated `packages/rust/src/native-targets.generated.ts` | PackagingSpecAuthor |
| `packages/rust/Cargo.toml` (workspace member + `[workspace.dependencies]`), `packages/rust/package.json` (new scripts), root `package.json` (typecheck/bootstrap wiring) | main session — change requests in §10 |
| Desktop build chain: `prepare-runtime-assets.mjs`, `electron-builder.config.js`, new `prepare:rust-native` script | PackagingSpecAuthor |
| CLI/SEA build chain: `sea-tui-assets.mjs`, `build-sea.mjs`, `scripts/zcode-distribution-smoke.mjs` | PackagingSpecAuthor |
| `scripts/dev-tauri.mjs` (`ZCODE_NATIVE_DIR`), the ten unwired crates, `loader.ts` candidate-path list | untouched / out of scope per §2.2 |

### 2.5 Invariants (this port's, on top of the umbrella's 1-10)

- **P1 — Rust decides, other languages execute.** No JavaScript, TypeScript, or shell code may
  enumerate crates, compute a platform suffix, decide whether a binary ships, or decide whether a
  staged tree is acceptable. Those four decisions live in `zcode-packaging`. Build scripts may only
  spawn it and move files it named.
- **P2 — Fail loud, never partial.** A missing, unreadable, size-mismatched, or hash-mismatched
  binary **fails the build** with a non-zero exit and a message naming crate, target, expected
  path, and expected sha256. There is no `if (existsSync) copy()` shape anywhere in the chain, and
  no build flag that downgrades the check to a warning.
- **P3 — No new runtime path.** This port adds no runtime branch. `loadNative()` keeps throwing
  (umbrella invariant 1). The difference is that the build can no longer produce an artifact that
  trips it.
- **P4 — One suffix table.** The target→suffix mapping exists once, in Rust. `loader.ts` reads
  generated constants; a Rust unit test regenerates and diffs, so drift is a failing test, not a
  runtime surprise.
- **P5 — Only live binaries ship.** A crate with no resolved consumer is not staged. The live set
  is derived (§4.2), not hardcoded, so adding a consumer automatically adds it to the payload and
  removing one automatically removes it.
- **P6 — Byte identity.** The staged file is the exact `cargo build --release` artifact, verified
  by sha256 over the whole file. No re-linking, stripping, compression, or rewriting.
- **P7 — Host-independent determinism.** The same `--target` yields a byte-identical plan on
  Linux, macOS, and Windows, and on a machine that has never run `cargo`. Plans are a pure function
  of (workspace manifest, target, artifact directory contents).
- **P8 — Local IO only.** No network, no credentials, no environment-dependent secrets. The tool
  reads the workspace and the artifact directory and writes a staging directory and a plan file.

---

## 3. Why Rust owns this, and what "fully Rust, no JS fallback" means here

The governing constraint for this port is the user's: implement the packaging decision and its
verification in Rust, with no JavaScript fallback anywhere.

Concretely, that rules out the shape the repo already uses for koffi. `koffi-package-assets.mjs`
is the closest existing precedent, and it is the shape this port must **not** copy:

- It re-implements the platform key in JS (`koffiPlatformKey`, `koffi-package-assets.mjs:35-37`),
  a second copy of a table that also exists in the koffi package itself.
- Its staging is best-effort in spirit: `verifyStagedKoffi` (`:68-81`) returns a list of problem
  strings rather than failing, and — measured — **is imported at `electron-builder.config.js:23` and
  never called**. A dangling verification import is the exact failure mode P2 exists to prevent.
- Its file filter lives in a JS predicate (`sea-tui-assets.mjs:296-311`), which is why the
  workspace-package branch at `:288-291` silently excludes `@zcode/rust`'s `.node` files (§1.3).

So "no JS fallback" is implemented as **P1 + P2**: JavaScript may spawn the tool and copy the
files it names, but it holds no rule, no table, and no tolerance. If `zcode-packaging` is missing
or fails, the build fails — there is no JavaScript path that takes over, because there is no
JavaScript path that could.

`loadNative()` remaining TypeScript is not a fallback (it is the loader, and `require()` is a JS
primitive); P4 removes its only *decision* — the suffix table — by generating it from Rust.

---

## 4. Design

### 4.1 Crate shape

```toml
# packages/rust/crates/zcode-packaging/Cargo.toml
[package]
name = "zcode-packaging"
version.workspace = true
edition.workspace = true
license.workspace = true
publish.workspace = true

[[bin]]
name = "zcode-packaging"
path = "src/main.rs"
# bin, NOT cdylib: this tool must never be emitted as a loadable .node (§2.3)
```

Workspace member is picked up by the existing `members = ["crates/*"]`
(`packages/rust/Cargo.toml:2`); the crate needs no `[workspace.dependencies]` entry because it uses
only `std` plus `serde`/`serde_json`, which are already workspace dependencies
(`packages/rust/Cargo.toml:14`, `:21`).

### 4.2 Surfaces and the live set

Three staging surfaces, each with its own destination root:

| Surface | Destination root (relative) | Consumed by | Loader candidate |
|---|---|---|---|
| `desktop-agent` | `packages/desktop/bundled-agents/<os>-<arch>/glm/native/` | the agent bundle run by Electron's Node | `loader.ts:60` (`join(here, "..", "native", fileName)`) |
| `sea` | the SEA asset tree assembled by `sea-tui-assets.mjs` | the single-file `zcode` binary | `loader.ts:60` after extraction |
| `dev` | `packages/rust/` (in place) | local dev / `pnpm dev:desktop` | `loader.ts:58` (`join(here, "..", fileName)`) |

`dev` is the status quo and is verified but not rewritten.

**The live set** is computed, not declared. `zcode-packaging plan` walks
`packages/rust/package.json`'s `exports` subpaths, reads each subpath's wrapper, extracts the
`loadNative<…>("zcode-<crate>")` literal, and then searches the workspace (excluding `node_modules`,
`dist`, `target`, `packages/rust`, and `docs/`) for an import of that subpath. A crate is
**live** when at least one importer exists. The result is written into the plan and printed, so a
newly-orphaned crate shows up in build logs as a *deletion* from the payload rather than silently
disappearing.

This is deliberately a **textual** analysis rather than a module-graph walk: the wrappers are
plain TS with a literal string argument, the importers are plain `import`/`require` specifiers, and
a resolver would add a dependency (`ts-morph` is already a root devDependency, so the harder version
is possible but is not needed for 18 subpaths). §10 records the trade-off and the escalation path.

### 4.3 The suffix table and its generated consumer

Rust owns the table (replacing `build-native.sh:9-14`):

| target triple | suffix | lib ext |
|---|---|---|
| `x86_64-unknown-linux-gnu` | `linux-x64-gnu` | `so` |
| `aarch64-unknown-linux-gnu` | `linux-arm64-gnu` | `so` |
| `x86_64-apple-darwin` | `darwin-x64` | `dylib` |
| `aarch64-apple-darwin` | `darwin-arm64` | `dylib` |
| `x86_64-pc-windows-msvc` | `win32-x64-msvc` | `dll` |
| `aarch64-pc-windows-msvc` | `win32-arm64-msvc` | `dll` |

These six rows are identical to `loader.ts:34-51` and `build-native.sh:9-14`; the spec exists to
make them identical *by construction*.

`zcode-packaging gen-targets` emits `packages/rust/src/native-targets.generated.ts`:

```ts
// GENERATED by `cargo run -p zcode-packaging -- gen-targets`. Do not edit.
// Source of truth: packages/rust/crates/zcode-packaging/src/target.rs
export const NATIVE_PLATFORM_SUFFIXES = {
  "linux-x64": "linux-x64-gnu",
  "linux-arm64": "linux-arm64-gnu",
  "darwin-x64": "darwin-x64",
  "darwin-arm64": "darwin-arm64",
  "win32-x64": "win32-x64-msvc",
  "win32-arm64": "win32-arm64-msvc",
} as const;
export type NativePlatformKey = keyof typeof NATIVE_PLATFORM_SUFFIXES;
```

`loader.ts`'s `nativePlatformTarget()` then becomes a lookup plus the existing unsupported-platform
throw, with no table of its own. A Rust unit test runs the generator and byte-compares against the
checked-in file, so a hand-edit fails `cargo test` (P4).

### 4.4 CLI surface

```
zcode-packaging plan   --target <os>-<arch> --surface <desktop-agent|sea|dev> --out <plan.json>
zcode-packaging stage  --plan <plan.json> --artifacts <dir> --dest <dir>
zcode-packaging verify --plan <plan.json> --root <dir> [--json]
zcode-packaging gen-targets [--check]
zcode-packaging inventory
```

**Plan format** (stable, versioned — this file is the schema):

```jsonc
{
  "schemaVersion": 1,
  "target": "darwin-arm64",
  "suffix": "darwin-arm64",
  "surface": "desktop-agent",
  "entries": [
    {
      "crate": "zcode-git",
      "source": "libzcode_git.dylib",          // basename under target/<triple>/release
      "dest": "zcode-git.darwin-arm64.node",   // basename under the surface root
      "bytes": 4997120,
      "sha256": "…"
    }
  ],
  "skipped": [
    { "crate": "zcode-rpc-server", "reason": "rlib; linked into the Tauri host, emits no shared object" },
    { "crate": "zcode-projection", "reason": "no consumer (umbrella invariant 9: renderer-safe TS twin)" }
  ]
}
```

- `plan` **fails** (exit 2) if any live crate's artifact is absent for the target — it does not
  emit a partial plan (P2).
- `stage` copies exactly the `entries`, re-hashing after the copy and failing on mismatch (P6).
- `verify` checks every `entry` exists with the recorded size and sha256, **and** that the root
  contains no `zcode-*.node` outside the plan. Extra binaries are an error, not a warning — that
  is what stops the ten dead crates from creeping back in (P5).
- `inventory` prints the live/skipped classification with importer paths, for review.

### 4.5 State owners and event order

```mermaid
flowchart LR
  subgraph BUILD["Build chain (JS/TS executes, never decides)"]
    PRA["prepare:runtime-assets.mjs<br/>localRuntimeScripts"]
    EB["electron-builder.config.js<br/>afterPack"]
    SEA["sea-tui-assets.mjs<br/>asset filter"]
    SMOKE["zcode-distribution-smoke.mjs"]
  end
  subgraph RUST["zcode-packaging (sole decision owner)"]
    P["plan<br/>classify + hash + fail-loud"]
    S["stage<br/>copy + re-hash"]
    V["verify<br/>existence + size + sha + no-extras"]
    G["gen-targets<br/>codegen"]
  end
  subgraph ART["Artifacts"]
    CR["cargo build --release<br/>target/&lt;triple&gt;/release/"]
    OUT["packages/rust/*.node<br/>(dev surface)"]
    DESTS["desktop-agent native/<br/>sea native/"]
  end
  LOAD["loader.ts<br/>loadNative() — consumer only,<br/>reads generated suffix table"]
  CR --> P
  P --> S --> DESTS
  P --> V
  EB --> V
  SMOKE --> V
  G --> LOAD
  S --> OUT
  LOAD -.->|"require() at runtime"| DESTS
```

- **Event order:** `plan` (hash the sources) → `stage` (copy, re-hash) → `verify` (re-hash the
  destination). Each step is a separate process invocation so a failure is attributable to exactly
  one phase, and the plan file is the artifact that ties them together.
- **Owner/lease:** the plan file is the single immutable handoff between phases. It is written once
  by `plan` and read-only afterwards; a stale plan is detected because its sha256 values no longer
  match the sources.
- **Idempotency:** `stage` overwrites by copy and re-verifies; running it twice yields the same
  bytes. `verify` is pure and may run any number of times.
- **Explicit time:** none. No polling, no watch, no retry. Every phase is a synchronous
  build-step invocation (umbrella `AGENTS.md:41`: no timeout-based coordination).

---

## 5. Migration boundary

### 5.1 Deleted (invariant 2)

| Removed | Replaced by | Evidence |
|---|---|---|
| suffix table, `build-native.sh:9-16` | `zcode-packaging` target table (§4.3) | the TS twin is `loader.ts:34-51` |
| crate glob + `Cargo.toml` grep + copy loop, `build-native.sh:21-46` | `cargo build --release` + `zcode-packaging stage` | the loop's own comment at `:25-29` already flags the grep as fragile |
| `nativePlatformTarget()`'s switch body, `loader.ts:34-51` | lookup over generated constants (§4.3) | — |
| the `@zcode/rust` special case that does not exist in `sea-tui-assets.mjs:288-291` | Rust-staged SEA `native/` tree (§6.2) | the allowlist is the *cause* of §1.3 |
| the stale claim at `prepare-agent-node-bundle.mjs:7` | corrected comment naming the seven live binaries | §1.2 |

`build-native.sh` is **not** deleted — it is reduced to `cargo build --release` plus one
`cargo run -p zcode-packaging` call, because `package.json`'s `build:native` is referenced from
`PORT_STATUS.md`, `dev-tauri.mjs`, and the README, and deleting a documented entry point is a
larger change than this port owns.

### 5.2 Rewritten

- `packages/rust/scripts/build-native.sh` — ~46 lines → ~8.
- `packages/rust/src/loader.ts` — `nativePlatformTarget()` body only; `candidatePaths()` unchanged
  (its order is a runtime concern, not a build concern).
- `packages/rust/scripts/build-native.sh`'s crate-type comment block — deleted with the grep.

### 5.3 Consumers changed (exact edits)

| File | Change | Why |
|---|---|---|
| `packages/desktop/scripts/prepare-runtime-assets.mjs:29-34` | add `prepare:rust-native` to `localRuntimeScripts` | the desktop chain's only hook for local runtime assets (§1.1) |
| `packages/desktop/package.json` scripts | add `"prepare:rust-native": "…zcode-packaging stage --surface desktop-agent…"` | mirrors `prepare:agent-bundle` |
| `packages/desktop/electron-builder.config.js:593-618` | add a `runTimedSync("afterPack:assertPackagedRustNative", …)` calling `verify` | the koffi slot that was imported and never called (§3) |
| `apps/zcode-cli/packages/cli/scripts/sea-tui-assets.mjs:288-291` | the workspace-package allowlist stops owning `.node`; Rust stages the SEA `native/` tree and the filter passes it through | §1.3 |
| `apps/zcode-cli/packages/cli/scripts/build-sea.mjs` | invoke `verify --surface sea` after assets are collected | the SEA equivalent of the afterPack assert |
| `scripts/zcode-distribution-smoke.mjs` | assert every live `.node` is present in the extracted distribution | §1.6 — the comment already promises this |
| `packages/desktop/scripts/prepare-agent-node-bundle.mjs:7` | correct the comment | §1.2 |

**Not changed:** `scripts/dev-tauri.mjs` (its `ZCODE_NATIVE_DIR` is a path override, documented as
allowed in §9, D3), `desktop-native-package-policy.mjs`, `electron-builder.config.js` `files` /
`extraResources` (the staged tree is inside the agent bundle, which is already packaged).

---

## 6. Failure semantics

- **Tool missing / not built** → the `cargo run` invocation fails; the calling pnpm script exits
  non-zero. No JS-side `try/catch` continues the build (P1, P2).
- **Live crate artifact absent for the target** → `plan` exits 2 and names the crate, the target,
  the expected source path, and the full list of artifacts it did find. The build stops here, so
  the failure is attributed to the port, not to a user action three weeks later (§1.5).
- **Artifact present but unreadable / hash mismatch after copy** → `stage` exits 3, naming the
  entry and both hashes.
- **Staged tree missing an entry, or carrying an extra `zcode-*.node`** → `verify` exits 4 with one
  line per problem: `missing`, `size-mismatch`, `sha256-mismatch`, or `unexpected`.
- **Wrong target suffix requested** (e.g. `darwin-x64` artifacts for a `darwin-arm64` target) →
  `plan` fails on the first missing artifact; the suffix table has no fuzzy matching and no
  "closest match" behaviour.
- **Generated suffix file hand-edited** → `cargo test -p zcode-packaging` fails (P4). The build
  does not silently accept it.
- **A crate loses its last consumer** → it moves from `entries` to `skipped` with a reason. The
  build still succeeds; the payload shrinks; the change is visible in the log (P5).
- **A new crate is added with no consumer** → appears in `skipped`; `inventory` surfaces it. This
  port does not delete it (D1).

---

## 7. Divergences

- **D1 — dead crates are excluded, not deleted.** The ten zero-consumer crates keep building (they
  are cheap to compile and their `cargo test` suites still run) but are not packaged. Deleting them
  is a separate invariant-2 change, because `zcode-rpc-server` and the Tauri host are entangled
  with the same family and a mistaken deletion is expensive to undo.
- **D2 — the agent-bundle staging path is new.** `stageKoffiIntoBundledAgents` is exported and
  never called (§3); there is no working in-repo precedent for staging into
  `bundled-agents/<key>/glm/`. This port establishes that path for Rust. If it turns out
  `bundled-agents` is not where the agent resolves `native/` from at runtime, the fix is a
  destination-root change in the plan, not a code change — which is precisely why the destination
  is plan data.
- **D3 — `ZCODE_NATIVE_DIR` stays.** It is a path override, not an implementation switch: it changes
  *where* the same bytes are read from, never *what* runs. The umbrella spec's ban is on
  `try { native } catch { legacy }` shapes, which this is not. It is documented here so its
  legality is a decision rather than an oversight. `dev-tauri.mjs:284-288` keeps using it.
- **D4 — the plan is a new artifact.** `*.json` plan files appear in build temp directories. They
  are build output, not source, and must be gitignored (§10).
- **D5 — textual liveness analysis.** §4.2 resolves consumers by string match, not module
  resolution. A consumer reached only through a computed specifier
  (`` `@zcode/rust/${name}` ``) would be missed and its crate would be dropped from the payload. No
  such dynamic import exists today (verified across the tree), and the failure mode is a loud
  `afterPack` assert rather than a silent regression.

---

## 8. Acceptance checklist (implementation wave, checked before merge)

1. Spec (this file) precedes implementation in git history.
2. `cargo build --release -p zcode-packaging` succeeds; `cargo test -p zcode-packaging` passes,
   including the `gen-targets --check` freshness test (P4).
3. `pnpm --filter @zcode/rust build:native` produces exactly the 17 `cdylib` `.node` files and
   skips `zcode-rpc-server` (rlib) — same set as today, verified by name.
4. **Suffix parity:** a scratch script asserts, for all six targets, that
   `zcode-packaging`'s table, the generated TS constants, and a `node -e` call to
   `nativePlatformTarget()` under a faked `process.platform`/`process.arch` all agree. Evidence
   quoted in the report.
5. **Live-set correctness:** `zcode-packaging inventory` output matches an independent
   `rg`-based count of importers per subpath (§1.4's table is the expected output).
6. **Payload correctness:** for each of the three surfaces, `stage` then `verify` exits 0, and the
   destination contains exactly the live set — 7 binaries, no `zcode-projection`, no
   `zcode-rpc-server`.
7. **Fail-loud proof (P2):** with one live binary temporarily removed from the source directory,
   `plan` exits non-zero and names it. With one byte flipped in a staged file, `verify` exits
   non-zero with `sha256-mismatch`. With `zcode-projection.node` copied in by hand, `verify` exits
   non-zero with `unexpected`. All three are demonstrated in the report.
8. **No-JS-decision proof (P1):** `rg` over the build chain shows no crate enumeration, no
   platform-suffix table, and no `existsSync`-guarded native copy outside `zcode-packaging`. The
   only permitted native-related JS is: spawning the tool, and `loader.ts`'s `candidatePaths()` /
   `loadNative()`.
9. **Desktop chain:** `pnpm --filter @zcode/desktop prepare:rust-native` stages the tree, and
   `afterPack` runs `verify` — proven by a deliberate corruption before packaging (P2).
10. **SEA chain:** `pnpm build:sea` produces a binary whose extracted asset tree contains the 7
    live binaries, and `build-sea`'s `verify` passes.
11. **Distribution smoke:** `node scripts/zcode-distribution-smoke.mjs` asserts every live binary is
    present in the extracted distribution (§1.6). A deliberately removed binary fails the smoke.
12. **Renderer-graph gate unchanged:** `node packages/shared/scripts/check-native-graph.mjs` still
    reports zero `@zcode/rust` imports under `packages/shared/src/zcode-protocol-v4/`
    (umbrella invariant 9) — packaging must not drag native into the renderer bundle.
13. **Typecheck:** root `pnpm typecheck` (covers `packages/rust`), `pnpm --dir apps/zcode-cli check`,
    and `pnpm --filter @zcode/desktop exec tsc -p tsconfig.host.json`.
14. **Lint/architecture:** `pnpm lint` reports no new warnings in this port's files;
    `pnpm architecture:check --changed` reports 0 new violations. Consumers import
    `@zcode/rust/<subpath>` only — no deep paths into `packages/rust/src/`.
15. **Docs:** the false claim at `prepare-agent-node-bundle.mjs:7` is corrected, and the
    `PORT_STATUS.md` prerequisite line ("run `pnpm --filter @zcode/rust build:native` once") is
    updated to state that packaging is automatic for release builds.

---

## 9. Shared-file change requests (main session)

| File | Exact change | Why |
|---|---|---|
| `packages/rust/Cargo.toml` | **no change** — `members = ["crates/*"]` already picks up the new crate; no new `[workspace.dependencies]` entry (only `serde`/`serde_json`, both present at `:20-22`) | verified |
| `packages/rust/package.json` | add `"build:packaging": "cargo build --release -p zcode-packaging"` and `"verify:packaging": "cargo run -p zcode-packaging -- verify …"`; `build:native` keeps its name | `PORT_STATUS.md` and `dev-tauri.mjs` reference `build:native`; do not rename |
| root `package.json` | **no change** — `packages/rust` is already in the `typecheck` project list, and `build:bootstrap` already builds workspace packages | verified |
| root `.gitignore` | add `packages/rust/target/` (present) and the plan-file pattern `*.native-plan.json` | D4 |
| `architecture-policy.yaml` | **no change** — module `rust` already exists with `publicEntrypoints: [packages/rust/src/index.ts]`; the new crate is under that root and `forbidDeepImports` is global. If `index.ts` must re-export the generated table, that is a one-line addition. | verified |
| `packages/desktop/electron-builder.config.js` | the `afterPack` addition in §5.3 | §1.1 |
| `apps/zcode-cli/packages/cli/package.json` | **no change** — `zcode-packaging` is a build-time tool and is never bundled. Note that `resolveBuildExternal` (`build.mjs:19`) must keep **not** listing `@zcode/rust`: the inlining at `:14-18` is required, and this port does not change it (see R2). | verified |
| `pnpm-lock.yaml` | **no change** — the crate adds no new external dependency | verified |

---

## 10. Risks / blockers

- **R1 — the `bundled-agents` destination may be wrong (D2).** The agent bundle's runtime
  resolution of `native/` has not been observed at runtime, because today nothing stages it. First
  implementation step should be a scratch experiment that writes a file to
  `bundled-agents/<key>/glm/native/` and confirms `loadNative()` finds it from the built
  `zcode.cjs`. If it does not, the destination is plan data and the fix is cheap — but the spec
  must be corrected before the code lands.
- **R2 — `@zcode/rust` is deliberately INLINED, and that invalidates the obvious destination.**
  `resolveBuildExternal` is exactly `["@zcode/tui", "playwright-core", "koffi"]`
  (`apps/zcode-cli/packages/cli/scripts/build.mjs:19`) — `@zcode/rust` is **not** in it, and the
  comment at `:14-18` says why: *"must NOT stay external: its package exports point at TypeScript
  sources… The wrapper is inlined… while the compiled `.node` binary is still resolved at runtime by
  `loadNative()` from the `@zcode/rust` package directory."* The same choice is made for the desktop
  bundles (`tsup.config.ts:169-172`, `:232-234`, `:265`).

  This means the `native/` candidate at `loader.ts:60` is resolved relative to the **bundle's**
  `__dirname`, not to `packages/rust/`. `hostModulePath()` (`loader.ts:16-24`) exists precisely
  because inlining breaks `import.meta.url`. So "stage into `bundled-agents/<key>/glm/native/`"
  (§4.2) is correct only if that directory is an ancestor of the built `zcode.cjs`; otherwise the
  `native/` candidate will never match and `loadNative()` will fall through to
  `@zcode/rust/package.json` resolution, which does not exist in a package with no
  `node_modules`. **R1 and R2 must both be answered by experiment before the destination is
  hardcoded** — this is the single most likely reason a first implementation attempt ships a
  package that still throws.
- **R3 — Windows `.node` on the asar boundary.** electron-builder unpacks `.node` files out of
  asar automatically, but a `.node` inside a *nested* `native/` directory under `extraResources` or
  a bundle may not be detected by that heuristic. Verify with a real packaged build, not a
  directory listing.
- **R4 — the distribution smoke runs outside the repo** (`zcode-distribution-smoke.mjs:1`), so it
  must resolve the plan's sha256 values from a file that survives packaging, or recompute from the
  extracted tree against a manifest copied alongside it. Decide during implementation; the
  acceptance criterion (11) is fixed either way.
- **R5 — `sea-tui-assets.mjs`'s filter is a deny-list over a walked tree.** Replacing the
  workspace-package allowlist (§5.3) touches the TUI asset collection, which is on the critical
  path for `zcode --web`. A regression there is user-visible; the acceptance run must exercise both
  `zcode` (TUI) and `zcode --web`.
- **R6 — CI has no Rust for the desktop job.** `build-native.sh` requires `rustc` today and is not
  in the desktop chain, so desktop CI may not have a toolchain. Adding it to
  `localRuntimeScripts` makes the desktop job depend on Rust. This port needs either a cached
  toolchain in that job or prebuilt artifacts fetched by `prepare:rust-native` — a pipeline change
  that must be sequenced with the main session.
- **R7 — `zcode-events` is the largest binary (3 MB) and links bundled SQLite.** Packaging it into
  six platform artifacts grows the release matrix; confirm the download-size budget with whoever
  owns release before merge.
