# Spec: Rust port program (full port, UI excluded)

Status: active. Owner: main session. Written before implementation, per `AGENTS.md:3`.

This is the umbrella for extending the native-port effort from the completed ad-hoc ports
(image, git, diff, codec, events, markdown, cron, mcp-config, task-index, packaging) to
**every remaining non-UI TypeScript subsystem**. It extends `docs/specs/rust-native-ports.md`,
which owns the delivery model and the 10 invariants; this document owns scope, wave order, and
acceptance. Where the two disagree, `rust-native-ports.md` wins on invariants and this document
wins on sequencing.

## 0. Naming reconciliation

The prior programme used "wave" to mean "batches 1 and 2" of a ~5-port effort. "Wave" here means
one ordered increment of the port programme. Ports keep the `zcode-<surface>` crate naming.

## 1. Scope

### 1.1 In scope — port to Rust

Every Node-only TypeScript subsystem outside `packages/ui` and outside `apps/zcode-cli`.
Measured at 2026-09-30, excluding `dist/`, `out/`, and `test/`:

| Package | Files | Lines | Waves |
| --- | --- | --- | --- |
| `packages/services` | 321 | 97,375 | 1–6 |
| `packages/desktop` | 266 | 61,337 | 4–6 |
| `packages/shared` | 226 | 41,247 | 2, 3 |
| `packages/server` | 49 | 10,463 | 5 |
| `packages/zcode-server-cli` | 43 | 5,771 | 5 |
| `packages/provider` + `provider-node` + `model-option-map` | 48 | 7,623 | 3 |
| `packages/rpc` | 22 | 4,307 | 3 |
| `packages/web` | 17 | 2,900 | 5 |
| `packages/client` | 6 | 722 | 5 |
| **Total** | **998** | **236,215** | |

`apps/zcode-cli` (291,276 lines) is **deferred by user decision** and is not in this programme.
It keeps its existing `zcode-events` / `zcode-task-index` native paths, which are unaffected.

### 1.2 Out of scope — explicitly NOT fallbacks

- **Everything the renderer bundle can reach.** `packages/ui/**` in full, plus
  `packages/shared/src/zcode-protocol-v4/**` and any other module reachable from
  `packages/web/src/main.tsx` or the Electron renderer entry. This is invariant 9 of
  `rust-native-ports.md` restated as scope: a renderer-reachable module must not statically
  import `@zcode/rust` because the renderer is a sandboxed context that cannot load a `.node`.
  Where a pure-compute helper is wanted by both, the correct shape is a Node-only subpath plus a
  renderer-safe barrel — never a runtime `try { native } catch { js }` branch.
- **Electron surface that has no Rust equivalent**: BrowserWindow lifecycle, `webContents`
  events, `session` / partition policy, protocol handlers, `webview` attach, auto-updater,
  IPC wiring, and packaging. These are the desktop Electron APIs, not computation.
- **Network and event-loop orchestration**: bot channel runtimes, OAuth HTTP flows, and the
  zcode-agent protocol service. These are async IO whose cost is dominated by the network, not
  by the compute. Invariant 10 applies: porting them cannot win.
- **Anything whose measured FFI cost exceeds the work it moves.** `rust-native-ports.md`
  invariant 10 already rejected `base64`, `vql*`, `alloc`, `slice`, `concat` on measurement.
  That ruling is inherited, not reopened.

### 1.3 The zero-fallback rule, restated for this programme

Invariant 1 ("zero JS fallback") and invariant 2 ("legacy paths are deleted, not disabled") of
`rust-native-ports.md` are non-negotiable and are the acceptance gate for every port in this
programme. Concretely, a port is not done until the TypeScript implementation it replaced has
**no remaining import path, no `catch` → legacy branch, and no environment flag** selecting it.

## 2. Why the file and terminal surfaces are sequenced first

Two of the three critical security findings from the 2026-09-30 analysis are reached through
exactly these two services, and both are a direct consequence of the work being done in
JavaScript rather than a lack of policy intent:

- `packages/services/src/file/fileService.ts:425-428` — `resolvePath` is a bare `realpath` with
  no containment. `readTextFile` (`:477`) then opens any caller-supplied absolute path.
- `packages/services/src/terminal/terminalService.ts:353-365` — `create()` has no permission
  service, no confirmation, and no sandbox anywhere in the method body; `write()` (`:415`) pipes
  straight to the pty.

Porting them places the confinement check **inside the native boundary**, where it cannot be
skipped by a caller that simply does not call the TS wrapper, and where it is enforced
identically for the desktop host, the server, and the CLI. That is a property the TS
implementation structurally could not have.

Wave 1 is therefore `file`, `terminal` profile detection, and `system`/`process` — the three
surfaces that are (a) large enough to matter, (b) fully Node-only, and (c) independently
buildable with no cross-port coupling.

## 3. Wave order and the dependency rule

Waves are ordered **leaves first**. A port in wave *n* may depend on crates from waves `1..n-1`
and on `@zcode/shared` type-only imports. It may not depend on a port in the same wave.

| Wave | Surfaces | Rationale |
| --- | --- | --- |
| 1 | `file`, `terminal-profile`, `sysinfo` | Leaves. No dependencies on each other. **DONE — see §8.** |
| 2 | `shared` pure-compute (path/compare/hash/codec helpers) | Consumed by everything below. |
| 3 | `rpc` byte port completion, `provider`, `provider-node`, `model-option-map` | Typed ports, no IO. |
| 4 | `services` orchestration layers on top of waves 1–3 | |
| 5 | `server`, `zcode-server-cli`, `web` bootstrap, `client` | |
| 6 | `desktop` host compute (not the Electron surface) | Last: it consumes the most. |

## 4. Ownership

Per `rust-native-ports.md` §Ownership, unchanged: each port's agent owns
`packages/rust/crates/<port>/**`, `packages/rust/src/<port>.ts`, and that port's spec file.
Shared files — `Cargo.toml`, `package.json`, `build-native.sh`, `loader.ts` — are owned by the
main session. **A port agent that needs a shared-file change requests it over IRC and does not
edit the file itself.** This is the one rule that prevents N agents from racing on
`packages/rust/package.json` exports.

## 5. Acceptance — per port

Everything in `rust-native-ports.md` §Acceptance, plus:

- The port's spec file exists and precedes the implementation.
- `cargo build --release -p zcode-<port>` succeeds and `build:native` emits the `.node`.
- **Differential proof where a JS predecessor existed**: the port's spec records N named input
  cases and their byte/shape-identical outputs across the old and new implementations. A port
  that changes output shape without a recorded differential is rejected.
- `cargo test -p zcode-<port>` passes, with at least one test per branch the port's spec lists
  under failure semantics. This is a **new** requirement versus the earlier programme, which
  shipped crates with no Rust tests of their own.
- The legacy TypeScript module and its now-orphaned helpers are deleted in the same change.
- Consumer typecheck reports no new errors; `pnpm lint` and `pnpm architecture:check --changed`
  report no new violations in the port's files.

## 6. Programme-level acceptance

- `packages/rust/crates/` contains one `cdylib` per ported surface and `packages/rust/package.json`
  exposes one subpath per crate, with no orphan in either direction.
- `pnpm --filter @zcode/rust native:inventory` reports **zero** unconsumed crates and zero
  subpath exports without a live caller.
- Grep proof: no `packages/services`, `packages/shared`, `packages/desktop`, `packages/server`,
  `packages/rpc`, `packages/provider*` module that is not renderer-reachable contains
  `node:fs`, `node:child_process`, `node:crypto`, or `node:sqlite` outside an explicit
  allowlist recorded in this document.
- `pnpm typecheck` and `pnpm lint` pass for the whole workspace with the UI and `apps/zcode-cli`
  unchanged.

## 7. Risks

- **R1 — FFI overhead on small primitives.** A port that moves < ~1 µs of work is a regression.
  Mitigation: invariant 10's measurement gate, applied per port before the port is written.
- **R2 — The renderer barrier (invariant 9) blocks parts of `packages/shared`.** Wave 2 must
  classify each shared module as renderer-reachable or Node-only *before* porting it, or the
  port will break the renderer bundle. `node packages/shared/scripts/check-native-graph.mjs` is
  the gate.
- **R3 — Cross-compilation does not exist.** `rust-native-packaging.md` R3 and the 2026-09-30
  analysis both record that the Rust stack builds only for the host target while the release
  matrix is six targets. This programme multiplies the exposed surface by the number of crates
  without fixing the underlying cross-build gap. **This is the highest programme-level risk and
  is tracked as a wave-6 blocker, not deferred silently.**
- **R4 — The parity discipline is manual.** Invariant 3 ("no behavior forks") is enforced by
  recorded differentials, which is a human process. With ~236k lines to port and no CI, a missed
  differential is undetectable. Mitigation: the per-port `cargo test` requirement in §5.
- **R5 — Packaging payload growth.** Every port adds a `.node` to the installer. Eleven ship
  today. `rust-native-packaging.md` records the payload rationale; this programme should
  re-check total size per wave rather than per port.

## 8. Wave 1 result — complete

Shipped 2026-10-01. Three crates, 183 tests, all green, all three confirmed shipping by
`native:inventory` (1 real importer each). Typecheck 0 errors, `pnpm lint` back at its pre-wave
baseline of 70 warnings / 0 errors, `architecture:check --changed` 0 new violations.

| Crate | Ports | TS deleted | Tests | Differential |
| --- | --- | --- | --- | --- |
| `zcode-fs` | `fileService.ts` implementation, `workspaceFileIgnore.ts`, `workspaceFileMentionFilter.ts` | 593 lines | 77 | 93 named inputs, 0 divergences |
| `zcode-terminal-profile` | `terminalProfile.ts`, `terminalProfileMacOs.ts` | 667 lines | 70 | 41/41 cases, incl. 4 that must throw |
| `zcode-sysinfo` | `processResourceSampler.ts` readers and parsers | ~300 lines | 36 | 16 fixture cases + 12 live deltas |

**The security-relevant one is `zcode-fs`.** Path containment now lives inside the native
boundary: `roots` is a required field of every path-taking request, the path is canonicalised
with all symlinks resolved, and admission is `Path::starts_with` (component-wise, so `/ws-evil`
is not accepted for root `/ws`). Verified against the built binary, not only in tests — symlink
escape, `..` traversal, out-of-root, and an omitted `roots` field are all rejected.

**Known limitation, carried forward, not resolved by this port:** the allowlist is a
*containment* boundary, not an *authorization* boundary. `IFileService` is a frozen IPC contract
and none of the four `createLocalServices` call sites passes a workspace path, so a caller can
still nominate a root. The escape classes are closed; which roots a session may open is decided
one layer up and is **wave 4 work**. See `rust-native-fs.md` §6 R1/R2. `DirectoryBrowser.tsx:95`
browses arbitrary directories and now fails above an admitted root — that is containment working,
and it is fixed by the same host hook.

**Two measurement findings that changed the design:**

1. `zcode-sysinfo` was **slower than the TypeScript it replaced** when written serially (6.681 ms
   against a 7.303 ms TS baseline — the TS `Promise.all` had already fanned across the libuv
   threadpool). The win only exists once parallelised, which is why `rayon` is a hard dependency
   rather than an optimisation. Final: 1.590 ms median for 294 processes end-to-end.
2. The `sysinfo` crate was **rejected for Linux** on two measured grounds: it walks
   `/proc/<pid>/task/*` and creates a `Process` per *thread* (993 entries for 296 processes, no
   public opt-out), and its `memory()` reads `statm` rather than `VmRSS` (131/298 pids differed).
   It is still the macOS and Windows implementation, where its field sources match the deleted
   readers exactly.

**Differentials earned their keep.** Across the three ports the replay caught 9 defects in the
first implementations, including: a JSON trailing-comma remover that duplicated every quote; a
kitty.conf regex that matched per line where the legacy `\s+` crosses newlines; a
`.catch(() => false)` on `checkFileExists` that silently turned "you may not look there" into
"it is not there"; and `Math.max(1, NaN)` being `NaN` in JS, so the legacy sampler returned
**0** for a saturated core where the naive Rust port returned **100**. That last one is the
argument for keeping the replay half of every differential.

**A rejected dependency, recorded so it is not re-proposed:** `mime_guess` was staged for
`zcode-fs` and removed. The predecessor's `inferMediaTypeFromPath` is a closed three-step
extension table and `mime_guess` disagrees with it (`audio/ogg` for `.opus`, `text/plain` for
`.ts`). Reproducing the table is invariant 3 compliance; matching a general-purpose crate is a
behavior fork. See `rust-native-fs.md` §3.7 / R9.

---

## 9. Next steps — concrete execution order (written 2026-10-01, after Wave 1)

Scope is unchanged from §1.1: **`packages/ui` and everything renderer-reachable, plus
`apps/zcode-cli`, stay untouched.** This section refines §3's wave table into executable steps. It
does not relax any invariant in `rust-native-ports.md`; where the two disagree, that spec wins.

### 9.0 Current state, corrected before sequencing

Wave 1 is complete (§8). Two facts on disk as of this writing that the wave table alone does not
show:

- **The whole working tree is uncommitted.** `HANDOFF-task-index-port.md` §3 item 1 is still open;
  before any new port, land the `task-index` §27/§28 change as its own commit. A port stacked on a
dirty tree cannot be reviewed or bisected.
- **`rust-native-config.md` has no implementation.** Its §7 acceptance checklist was marked `[x]`
  before the crate existed, so the marks were false. They are corrected to `[ ]` in the same change
  as this section. That spec is the ready-to-execute Step 1 below; nothing else in the programme is
  as far along.

### 9.1 The renderer barrier (R2) is the sequencing rule, not a footnote

Invariant 9 makes a renderer-reachable module an illegal native consumer. Measured 2026-10-01 with
`rg -l "@zcode/<pkg>" packages/{ui,web,client,shared,rpc}/src`:

| Package | Imported from renderer graph | May host a native import? |
| --- | --- | --- |
| `packages/services` | only through RPC, not bundled | **yes** (git, event-coalescer already do) |
| `packages/provider-node` | 0 | **yes** |
| `packages/zcode-cua`, `packages/formal-proof` | 0 | **yes** |
| `packages/desktop` main/host | not bundled | **yes** (Electron surface excluded, §1.2) |
| `packages/server`, `packages/zcode-server-cli` | not bundled | **yes** |
| `packages/provider` | 30 | **no** — needs Node-only subpath + renderer-safe barrel |
| `packages/model-option-map` | 1 (`shared/src/model-config.ts`) | **no** — same split |
| `packages/shared` | 722 | **no** at the barrel; only `src/node/**` **after** the gate is taught to sanction it |
| `packages/rpc` | 15 | only `packages/rpc/src/native/**` (already sanctioned) |

**Rule.** A step may only target a package whose every native-importing file sits outside the
renderer graph. Where the compute hides behind a renderer barrel, the step is blocked until the
`Node-only subpath + renderer-safe barrel` split exists — never a runtime
`try { native } catch { js }` (invariants 1 and 9).

### 9.2 Ordered steps

| # | Step | Crate | Source (Node-only) | Primary consumer(s) | Blocker |
| --- | --- | --- | --- | --- | --- |
| 0 | Land the dirty tree | — | — | — | `HANDOFF-task-index-port.md` §3.1 |
| 1 | Settings + hooks trust | `zcode-config` | `services/src/setting`, `services/src/hooks`, `services/src/settings-sync` schema/merge halves | `settingService`, `hooksService`, `settingsSyncService` | none — spec ready |
| 2 | Node-only shared primitives | `zcode-node-fs` (proposed) | `shared/src/node/{atomicFileLock,privateFilePersistence,subagentMarkdownMigration,officialPluginCache}` | services, desktop host, provider-node | **gate done** — `check-native-graph.mjs` sanctions the directory *and* asserts the subpath is unreachable from every renderer root |
| 2x | ~~`nodeSelfResourceTelemetry`~~ | — | measured and **rejected**: it converts `process.cpuUsage()`/`process.memoryUsage()` for the current process, which a Rust host has no equivalent of, and `zcode-sysinfo` reads *other* processes so it does not subsume it. Porting it would be a translation exercise with no compute win (invariant 10) | — | — |

### 9.5 Step 2 measured in full — the crate is not worth creating

All five `shared/src/node/` modules were examined before writing `zcode-node-fs`, and none is a port
that wins. The pattern is `zcode-fs` §2.2 restated: these are **host IO policy**, not compute.

| Module | Lines | Why it is not a candidate |
| --- | --- | --- |
| `atomicFileLock` | 275 | A lock protocol: a retry loop around `mkdir`/`O_EXCL` with stale detection. The compute (`parseLockMetadata`, timestamp validation) is a `JSON.parse` and a few numeric checks — below the FFI floor — and porting it alone leaves the IO loop with no body, the `migrate_legacy_common_mcp` trap. |
| `privateFilePersistence` | 121 | Atomic write + corrupt-file backup. Pure IO orchestration. |
| `subagentMarkdownMigration` | 97 | The migration compute, `importSubagentStateSelections`, **already lives in the renderer-safe `shared/src/subagent-state-migration.ts`**. The `node/` module is `readFile`/`writeFile`/`rename`/`chmod` plumbing around it, with nothing left to move. |
| `officialPluginCache` | 56 | Two `readdir`s with a transient-name filter and a `localeCompare` sort. IO with a trivial tail. |

**Conclusion: Step 2 ships no crate.** The gate work (§9.4, the reverse reachability check) was still
necessary — it is what lets wave 3 and 4 import a Node-only shared subpath safely — but the "primitives"
it was meant to unblock turned out to be IO, and invariant 10 rejects them. This is the second
measurement rejection recorded in this programme (`sysinfo`-the-crate was the first), and recording it
is cheaper than discovering a 0.3x port after it is written.

Wave 2's remaining value is therefore the gate, not a crate. The next real port is wave 3's
`provider-config-file-codec` / `legacy-reasoning-level` pair, which carry genuine schema and
rename-table compute — but both consume `@zcode/provider`, which `packages/ui` imports (30 files), so
they need the shared-schema-reimplementation shape `zcode-config` used, not a move.
| 3 | Provider-node pure compute | `zcode-provider-node` (proposed) | `provider-node/{provider-config-file-codec,personal-provider-config-repository,zcode-builtin-cache-paths,legacy-reasoning-level*,runtime-paths}` | `services/src/model-provider`, desktop | none (0 renderer imports) |
| 4 | Services host compute | per-surface | `usage-stats`, `fileWatcher`, `conversation-telemetry`, `cua-permission-broker`, residual `setting` | services only | per-file renderer classification |
| 5 | Server + `zcode-server-cli` | per-surface | `server` (10.3k), `zcode-server-cli` (5.7k) | self-contained | none |
| 6 | Desktop host compute | per-surface | desktop main/host, non-Electron | desktop host | Electron surface excluded |

Steps 1–3 are dependency-ordered and each is independently shippable. Step 4+ is not sequenced
yet because each surface needs its own renderer classification first (9.1).

### 9.3 Step 1 — `zcode-config`, executable checklist

Owner files and the full design already live in `docs/specs/rust-native-config.md`; this is only the
ordered work, not a second design.

- [ ] New crate `packages/rust/crates/zcode-config/**`, `cdylib` + `rlib`, one module per §3 concern
      (settings schema, hook model, trust store, settings-sync precedence).
- [ ] `packages/rust/src/config.ts` wrapper; subpath `@zcode/rust/config` added to
      `packages/rust/package.json` (shared file — request from the main session, do not edit).
- [ ] Workspace member + `pnpm --filter @zcode/rust build:native` emits the `.node`.
- [ ] Rewire consumers: `services/src/setting/{settingService,legacyAccountConnectionSettings}.ts`,
      `services/src/hooks/{hooksService,workspaceHookSettingsModel}.ts`,
      `services/src/settings-sync/settingsSyncService.ts`.
- [ ] Delete `services/src/setting/normalizeSettingsPatch.ts` (invariant 2 — delete, not disable).
- [ ] Leave byte-identical: `shared/src/validationAppSettings.ts`, the four
      `shared/src/workspace-hook-*.ts` modules, the `settingService` write queue / atomic write, the
      settings-sync filesystem orchestration, `readWorkspaceHookProjectSources` (all renderer- or
      CLI-side per §2.2). No `apps/zcode-cli` edit.
- [ ] `cargo test -p zcode-config` one test per §4 row; recorded differential over the merge and
      normalisation paths with zero divergences; direct-load smoke against the built `.node`.
- [ ] Gates: `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`,
      `node packages/shared/scripts/check-native-graph.mjs` — no new violations.
- [ ] Acceptance = `rust-native-config.md` §7, each box re-checked against the actual run.

### 9.4 Non-goals for the remainder of the programme

Explicitly out, so no step silently absorbs them:

- `packages/ui` and every renderer-reachable module (`shared` barrel, `rpc` barrel, `client`,
  `web`) — invariant 9.
- `apps/zcode-cli` — deferred by user decision (§1.1); it consumes native crates through its own
  existing paths, it is not ported.
- The Electron surface, network/event-loop orchestration, and the bot runtimes, OAuth HTTP flows
  and `zcode-agent` protocol service — §1.2 and invariant 10.
