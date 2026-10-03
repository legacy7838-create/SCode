# Spec: Rust native port of `packages/model-option-map`

Status: active. Owner: main session. Written before implementation, per `AGENTS.md:3`.
Extends `docs/specs/rust-native-ports.md` (delivery model + 10 invariants, binding) and
executes the wave-3 `model-option-map` row of `docs/specs/rust-native-program.md` §9.1.

## 1. Goal

Delete `packages/model-option-map` (8 TS modules, 867 LOC) with **zero JS fallback**:
every responsibility it owned moves behind the native binary, every consumer is rewired
in the same change, and the TS package directory is removed.

## 2. Current state (measured)

- **`crates/zcode-model-option-map` already exists as the full rlib port** (1,319 LOC:
  `tokenizer`, `parser`, `evaluator`, `compiler`, `merge_patch`, `option_maps`, `types`).
  Its `Display` for `RestrictedCelError` is `{message} at offset {offset}` — byte-identical
  to the TS `super(\`${message} at offset ${offset}\`)`, which is the error text the zod
  superRefine surfaced.
- The native host **already owns CEL-map validation**: `zcode-provider-config/src/schema.rs
  ::check_model_option_map` runs the same `compile_model_option_map` on **every** config
  decode and, because every persisted write goes through the strict decode→encode
  canonical round-trip, on every write as well.
- What is missing is the Node binding: the crate is `rlib` only, so the TS package is
  still the implementation for its three consumers:
  1. `packages/shared/src/model-config.ts` — zod `superRefine` on `map` (**renderer-reachable**),
  2. `apps/zcode-cli/packages/adapters/src/model/model-execution.ts` — `compileModelOptionMaps`
     at model creation, `apply` per request,
  3. `apps/zcode-cli/packages/adapters/test/opencode-free-reasoning-map.test.ts` —
     `compileModelOptionMap` + `applyOrderedJsonMergePatches` (differential corpus).
- Zero external users of `compileRestrictedCel`, `evaluateRestrictedCel`, the tokenizer/
  parser exports, or the error classes → they are internal and are **not bound** (no dead
  napi surface).

## 3. Boundary decision

### 3.1 The renderer path (`shared/src/model-config.ts`): validation ownership, not a fork

The zod `optionMapSchema` superRefine is the one consumer inside the renderer graph.
Invariant 9 makes it illegal for this module to import a native wrapper: the sandboxed
renderer cannot load a `.node`, and the static graph is the gate
(`check-native-graph.mjs` roots include `packages/shared/src`).

The superRefine is therefore **removed from the shared schema**, not re-implemented:

- **Native is already the single owner.** `check_model_option_map` validates every `map`
  string at decode and at every persisted write (§2). An invalid CEL map cannot reach the
  disk, cross the RPC boundary, or be loaded from a file — the native error surfaces with
  the same string the superRefine used to produce (`{message} at offset {offset}`).
- **The renderer never executed it.** No renderer-reachable code parses the optionSpecs
  zod schemas (`packages/ui` reads `optionSpecs` as data off typed views; the settings
  drafts save through RPC, whose error is the native validation error). The superRefine
  only ran when Node-side code parsed those schemas — Node-side parsing is now covered by
  the native boundary at the point where it matters: persistence.
- The schema keeps every non-CEL constraint (`values` non-empty/non-duplicate, `map`
  `.min(1)`), so the shape contract is unchanged; only the compile step's ownership moves.
- This is **not** a `try { native } catch { js }` branch and not an environment switch:
  there is exactly one implementation of the compile validation (Rust), and exactly one
  place that runs it (the native boundary). The renderer has no validation to fall back to.

### 3.2 Node consumers: native bindings, sync

The compute is a tiny-expression compile/evaluate plus merge-patch application over a
JSON document — microseconds, no IO, no async — so every binding is **synchronous**
(invariant 4 exempts sub-millisecond primitives).

| napi export | Replaces |
| --- | --- |
| `compileModelOptionMap(source, variable) → ModelOptionMapProgram { source, evaluate(input) }` | `compiler.ts` `compileModelOptionMap` |
| `compileModelOptionMaps(specs) → CompiledModelOptionMaps { apply(bodyJson, valuesJson) }` | `option-maps.ts` |
| `applyOrderedJsonMergePatches(bodyJson, patchesJson)` | `merge-patch.ts` |

Programs are compiled once and hold their AST, exactly like the TS `programCache`
closure — per-request cost is one evaluate + one patch application.

### 3.3 Invariant 10 — measured before binding

`apply` walks no body (patches target explicit paths), so a naïve object-in/object-out
binding could lose to V8. The binding shape is therefore decided by measurement, not
taste:

- Bench A: TS `compileModelOptionMaps().apply(body, values)` (object API) vs native
  `apply(bodyJson, valuesJson) → string` over 1 KB and 10 KB request bodies,
  100k iterations, median of 5 rounds.
- The adapter path already has the body as a **string** (`readRequestBody` → `parseJsonObject`
  → `apply` → `JSON.stringify`). A string-level native binding can delete the TS
  parse+stringify from that path entirely; if the measured numbers favour it, the adapter
  rewires to the string API and the wrapper keeps the object-shaped method as the
  interface-matching convenience (JS-side JSON.parse/stringify is then only paid by
  callers that genuinely hold objects).
- Numbers land in §7 before merge. If native loses both shapes, the ruling is recorded
  here and the binding is narrowed to `compileModelOptionMap` (compile-time work the TS
  caches today) — the port never ships a slower path silently.

## 4. Direct napi connection — no wrapper (second revision)

This crate does **not** use the `packages/rust/src/<port>.ts` wrapper pattern every other
native port follows. The CLI connects to the binary **directly through `loadNative`**,
which `@zcode/rust`'s root export already exposes:

- `model-execution.ts` loads the binary once (Node's `require`-cache makes later calls
  free) and calls `compileModelOptionMaps(JSON.stringify(specs))`; the native object's
  `apply(bodyJson, valuesJson)` is what the fetch seam calls per request.
- `model-option-map-fetch.ts` holds only the two structural shapes
  (`CompiledOptionMaps`, `ModelOptionValues`) — JSON primitives, no behaviour.
- The differential test loads the binary itself for `compileModelOptionMap` /
  `applyOrderedJsonMergePatches`.
- `packages/rust/src/modelOptionMap.ts` and the `./model-option-map` subpath export are
  **deleted**.

Why this is legal here and not a fallback:

1. The consumer is the Node-only CLI; the renderer-graph gate never sees it (invariant 9
   is about renderer-reachable modules, and the gate's roots do not include `apps/zcode-cli`).
2. Nothing falls back: a missing binary throws from `loadNative` exactly as before — the
   wrapper contained zero decision logic, only `JSON.stringify`/`JSON.parse` around calls
   that already speak JSON strings.
3. The types that the wrapper re-declared are trivial JSON shapes; they now live beside
   their two users instead of in a package layer.

**Packaging contract extension (required, additive).** `zcode-packaging`'s inventory
classified a cdylib as shippable *only* when its `@zcode/rust/<subpath>` export had an
importer. A direct consumer does not reference a subpath, so without a change the crate
would be dropped from the staging plan and the CLI would ship without its binary.
`inventory::build` now also scans for direct `loadNative("<crate>")` references
(`find_direct_load_native_importers`) and classifies such crates `Live { subpath: None }`.
The subpath mechanism is untouched for the other seventeen crates; a crate with neither a
subpath importer nor a direct reference still reports `NoSubpath` and never ships.
`packages/rust` itself stays excluded from the scan, so a wrapper cannot mark its own
crate live.

The wrapper pattern remains the default for every other port — this exception is scoped
to `zcode-model-option-map` because its boundary is two JSON-string calls with no
hydration step (unlike `provider-node`, whose wrapper exists to rehydrate domain objects).

## 5. Consumer rewiring (same change)

- `packages/shared/src/model-config.ts` — superRefine + import removed (§3.1);
  `@zcode/model-option-map` dep dropped from `packages/shared/package.json`.
- `apps/zcode-cli/packages/adapters/src/model/model-execution.ts`,
  `…/model-option-map-fetch.ts` (types), `test/opencode-free-reasoning-map.test.ts` —
  connected directly to the binary via `loadNative` (§4); `@zcode/rust/model-option-map`
  subpath export removed from `packages/rust/package.json`.
- The adapters test stays and runs against the **native** implementation — it is the
  differential corpus (real builtin config rule, disabled-deletes-thinking semantics,
  ordered merge patches).
- `packages/model-option-map/` deleted; `zcode-model-option-map` becomes `cdylib + rlib`
  (the rlib keeps serving `zcode-provider-config`), staged by the packaging inventory
  through the direct-reference detection of §4.

## 6. Invariants at risk, and how they are held

1. **Zero JS fallback** — the wrapper throws on a missing binary; no legacy branch exists
   because the legacy package is deleted in this change.
2. **Legacy deleted** — directory removed, zero references.
3. **No behavior forks** — error strings byte-identical (§2); merge-patch semantics and
   ordered application are the rlib's existing port with its tests; the differential test
   in §5 runs against native.
4. **Event-loop rule** — bindings are sync primitives (sub-ms), sanctioned by invariant 4.
9. **Renderer graph** — `packages/shared/src` gains no `@zcode/rust` import; the graph
   gate stays green.

## 7. Acceptance — actual results (2026-10-03)

- [x] This spec precedes the implementation (git history order).
- [x] `cargo build --release -p zcode-model-option-map` emits a cdylib;
      `cargo test -p zcode-model-option-map -p zcode-provider-config`: **75 tests pass**
      (10 in this crate incl. the two integer-spelling regressions below, 65 in the
      provider-config suite that re-proves schema-level CEL validation over the same rlib).
- [x] `pnpm --filter @zcode/rust build:native` stages
      `zcode-model-option-map.linux-x64-gnu.node` (16 files staged; the packaging
      inventory required the `@zcode/rust/model-option-map` importer).
- [x] Invariant-10 bench (`packages/rust/scripts/bench-model-option-map.mts`,
      `TS_REF=HEAD`, real builtin rules, median of 5 rounds):

  | shape | 1 KB body | 10 KB body |
  | --- | ---: | ---: |
  | ts-adapter (`JSON.parse` + `apply` + `JSON.stringify`) | 46,549 ns/op | 263,013 ns/op |
  | ts-apply (objects, lower bound) | 38,110 ns/op | 213,703 ns/op |
  | **native-json `applyJson` (shipped shape)** | **11,704 ns/op** | **75,258 ns/op** |

  **4.0× / 3.5× faster** than the path it replaces — and the adapter's own
  parse+stringify pair is deleted with it. Compile (once per model): TS 0.85 µs vs
  native 14.3 µs — the native side loses the micro-benchmark but 14 µs is paid at
  model creation/validation frequency, far below any perceptible threshold; the
  request path, where the volume is, wins by the table above. The shipped binding
  shape is the measured winner, as §3.3 required.
- [x] Byte parity: `ts.apply(body) == native.applyJson(bodyJson)` — asserted by the
      bench (`parity: byte-identical output`). **The bench caught a real defect**:
      `max_tokens: 8192` came back as `8192.0` (f64 spelling). Fixed in the rlib
      (`number_value` now emits the JS integer spelling; `ModelOptionValues` carries
      the JSON number, not `f64`; the boundary normalises JS numbers) and pinned by
      `integer_results_serialise_in_js_spelling` + `an_integer_option_value_reaches_the_body_unscaled`.
- [x] Error parity: 4/4 probe strings produce byte-identical messages
      (`unexpected token "" at offset 5`, `expected "}" at offset 20`,
      `function calls are not supported at offset 9`, `expression must not be empty at offset 0`).
      The 5th probe (an invalid *variable name*, which the TS `ModelOptionName` type
      rejected at compile time only) is rejected by the native side at runtime —
      unreachable from every typed call site.
- [x] The CLI differential test `opencode-free-reasoning-map.test.ts` passes **against
      the native binding** (2/2: real `space-bunny-free` builtin rule — disabled
      deletes `thinking`, enabled writes `{type:"adaptive"}` + `output_config`).
- [x] `pnpm typecheck` passes; `pnpm lint` 0 errors (52 pre-existing warnings, 0 in
      port files); **full** `pnpm architecture:check` 0 violations;
      `check-native-graph.mjs` OK (1,738 modules — 8 fewer, the deleted package);
      the shared schema change leaves the renderer graph clean because
      `packages/shared/src` gains no native import (§3.1).
- [x] `grep -r "@zcode/model-option-map"` yields no references; the package is deleted;
      the orphan dependency in `packages/provider/package.json` is dropped too.
- [x] **Second revision — direct napi connection (§4):**
      `packages/rust/src/modelOptionMap.ts` and the `./model-option-map` subpath export are
      deleted; `grep -r "@zcode/rust/model-option-map"` yields zero references;
      `zcode-packaging` classifies the crate `Live { subpath: None }` from the two direct
      `loadNative(...)` references (inventory prints `ship zcode-model-option-map — 2
      importer(s)`) and still stages all 16 binaries; three new packaging tests pin the
      direct-detection, the no-reference `NoSubpath` floor, and the untouched subpath path
      (43+5 pass); adapters typecheck clean; the differential test passes against the
      directly-loaded binary (2/2).
- Baseline-failing gates, unchanged by this port: `pnpm knip`, `pnpm fmt:check`
  (every file this change touches is `oxfmt --check` clean).

## 8. Non-goals

- `packages/provider` (which consumes these schemas) keeps its zod layers — wave 3.
- The tokenizer/parser/evaluator module split inside the crate is untouched; this port
  binds, it does not restructure.
