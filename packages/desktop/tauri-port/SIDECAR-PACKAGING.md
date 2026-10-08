# SIDECAR-PACKAGING.md — Packaging the Host / Scheduler / Agent as Tauri sidecars

> Read-only runbook (P2 enabler, follow-on to `SIDECAR-TRANSPORT.md`). No source edited.
> Goal: resolve the one open ASSUMPTION in `SIDECAR-TRANSPORT.md:74` (externalBin
> target-triple naming) and lay down the concrete packaging, config, capability, spawn
> and lifecycle steps so a later coding task can implement them.
> Rules from AGENTS.md apply: spec-before-code, single owner, flag-gated rollback, no
> credentials in logs, cross-platform (Win/mac/Linux) first.

## 0. Grounding: what the artifacts actually are today

Every claim below is tied to a real file I read.

- **Host** — `tsup` target `"host"` in `packages/desktop/tsup.config.ts:194-224` emits
  `packages/desktop/out/host/index.js` (ESM, `format:"esm"`, `platform:"node"`,
  `target:"node22"`) plus a worker `out/host/tasksStorageWorker.js`. Built by the `tsup`
  run inside `build:no-runtime-assets` → `scripts/run-production-build.mjs`
  (`packages/desktop/package.json:22`).
- **Scheduler** — `tsup` target `"scheduler"` (`tsup.config.ts:225-251`) emits
  `out/scheduler/index.js`. Same build run as the host.
- **Agent CLI** — `apps/zcode-cli/packages/cli/dist/zcode.cjs` (CJS, self-contained
  bundle), built by `scripts/build-desktop-agent-cli.mjs` (default `pnpm --filter
  @zcode/cli build:desktop-agent`, `build-desktop-agent-cli.mjs:148`) which calls
  `apps/zcode-cli/packages/cli/scripts/build.mjs`. Then staged to
  `packages/desktop/bundled-agents/<platformKey>/glm/zcode.cjs` by
  `stage-agent-bundle.mjs` (`resolveAgentBundlePaths`,
  `AGENT_BUNDLE_SOURCE_RELATIVE = "apps/zcode-cli/packages/cli/dist/zcode.cjs"`).

**Critical asymmetry (drives the whole recommendation):**

- The **Agent** is *already a standalone-executable-shaped artifact*:
  `build.mjs:226-228` writes an esbuild banner `#!/usr/bin/env node` (shebang) and
  `build.mjs:266` runs `chmod(outfile, 0o755)`. It is a fully `--bundle`d CJS file
  (workspace deps inlined via `noExternal`/alias, `build.mjs:241-259`).
- The **Host / Scheduler** are *not* self-contained. `tsup.config.ts:110-122` marks
  `node-pty`, `ssh2`, `undici`, `@larksuiteoapi/node-sdk`, `yaml`, `node-forge`,
  `yauzl` as **runtime `external`** — they are resolved from `node_modules` at run time
  and deliberately NOT inlined (comments explain the Electron dynamic-require crash they
  avoid). They are also ESM chunks (`host/chunk-[hash]`, `tsup.config.ts:220`) with
  multiple import targets, and they load native `.node` files.

So "make it a single file" is nearly free for the Agent but expensive for the Host.

## 1. Artifact inventory → sidecar mapping

| Sidecar name      | Current built artifact                                            | Build command (repo root)                                                                 | Native/deps at runtime? |
| ----------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------- |
| `zcode-host`      | `packages/desktop/out/host/index.js` (+ `tasksStorageWorker.js`)   | `pnpm --dir packages/desktop build:no-runtime-assets` (tsup `host` target)                | YES — node-pty, ssh2, undici, yaml, node-forge, yauzl + `.node` files |
| `zcode-scheduler` | `packages/desktop/out/scheduler/index.js`                        | same tsup run (`scheduler` target)                                                         | YES — same externals set |
| `zcode-agent`     | `apps/zcode-cli/.../cli/dist/zcode.cjs` → staged `bundled-agents/<platformKey>/glm/zcode.cjs` | `node scripts/build-desktop-agent-cli.mjs` (= `prepare:agent-bundle`) | Bundled CJS; only Node builtin + WASM ripgrep, no NAPI (`prepare-agent-node-bundle.mjs:6-9`) |

`platformKey` is `<platform>-<arch>` (`prepare-agent-node-bundle.mjs:70`, e.g.
`linux-x64`, `darwin-arm64`, `win32-x64`), overridable with
`ZCODE_TARGET_OS`/`ZCODE_TARGET_ARCH` (`:68-69`) — this already is the CI cross-build hook.

## 2. Making them standalone executables

Three options as tasked:

### (a) esbuild `--bundle` + `#!/usr/bin/env node` shebang + chmod +x — **RECOMMENDED**
Wrap the entry in an executable JS file that a **bundled `node` binary** runs. For the
Agent this is already done (see §0). For the Host/Scheduler add a thin esbuild pass that
keeps the native/dynamic externals as **external** (`node-pty`, `ssh2`, `undici`, …) and
ships them beside the binary in the Tauri `resources` dir — do NOT try to inline them
(the `tsup.config.ts:110-122` comments exist because inlining crashes the ESM runtime).

Lowest-friction rationale for THIS repo:
- The Agent needs **zero new tooling** — it already is a shebang'd, chmod'd, bundled CJS
  file. Just copy it to the externalBin path with a target-triple suffix (§3).
- The Host/Scheduler reuse the exact same Node execution model the Electron path already
  validated, so the `child_process.spawn(cmd,[entry,"app-server","--stdio"])` stdio
  JSON-RPC contract (`zcodeAgentProcessManager.ts:367-376`) stays verbatim. Only the
  `command` changes from `process.execPath`+`ELECTRON_RUN_AS_NODE=1` to a real `node`.
- No new build dependency (`pkg`/`sea` add CI fragility and native-asset friction —
  `build.mjs:240` already notes "SEA 资源由 build-sea 的 native asset 收集阶段单独处理",
  i.e. SEA needs its own asset pipeline for the `.node`/WASM files).

### (b) `pkg` / `node --experimental-sea-config` (single executable) — DEFER
Attractive only for the Agent (it has no NAPI deps). The `build.mjs:226-236` banner
already probes `require("node:sea")` and reads a `zcode-node-license` SEA asset, so SEA
is a known future path for the Agent. **Not** suitable for Host/Scheduler yet because of
their native `.node` externals. Mark as a P3 size/startup optimization to evaluate after
the WS transport lands.

### (c) system/node runtime invoked by a shell wrapper script — fallback only
Cheapest to prototype (a `#!/bin/sh` that `exec node "$DIR/index.js" "$@"`), but Windows
`.sh` is unreliable and AGENTS.md forbids shell-string command assembly / POSIX-only
assumptions. Acceptable for the §7 PoC only.

### Node runtime availability — the open question
The sidecar needs a Node runtime. Two sub-options:
1. **Ship a `node` binary per platform** next to the sidecar (recommended for determinism
   — the Agent targets `node22` and remote SSH already reuses a standalone Node v22.16,
   `build.mjs:255-257`). Cost: +~80MB per platform.
2. **Reuse a runtime** — there is no Electron runtime in a Tauri build, and Tauri's own
   process is Rust, so this only means "the user has node on PATH", which violates the
   self-contained install requirement. **Rejected.**
- **ASSUMPTION**: whether `tauri.conf.json` externalBin supports shipping a supporting
  `node` binary + `node_modules` as `resources` vs embedding node via SEA. Verify by
  building one sidecar and inspecting the produced bundle layout (`tauri build`, §8).

## 3. externalBin config + RESOLVING the target-triple naming rule

`SIDECAR-TRANSPORT.md:74` left this as ASSUMPTION. **Resolved** (Tauri v2 documented
behavior):

- In `tauri.conf.json > bundle > externalBin` you list the sidecar path **WITHOUT** the
  triple suffix. Tauri then copies the executable whose on-disk name is
  `<listed-path-with-trailing-segment-and-triple>`, i.e. the actual file must be named
  `<name>-<RUST_TARGET_TRIPLE>` (and `<name>-<triple>.exe` on Windows). The listed config
  entry is the *stem*.
- The target triple is Rust's target triple. Real values:
  - Linux x64: `x86_64-unknown-linux-gnu`
  - Linux arm64: `aarch64-unknown-linux-gnu`
  - macOS Intel: `x86_64-apple-darwin`
  - macOS Apple Silicon: `aarch64-apple-darwin`
  - Windows x64: `x86_64-pc-windows-msvc` (file gets `.exe`)
  - Windows arm64: `aarch64-pc-windows-msvc` (file gets `.exe`)
- At runtime the Rust API strips the triple: `Command::new_sidecar("zcode-host")` resolves
  to the correct platform binary automatically.

Exact config to add under `bundle` (`src-tauri/tauri.conf.json:26-36`, currently
`active:false`, no `externalBin`):

```jsonc
"bundle": {
  "active": true,
  "targets": "all",
  "externalBin": [
    "binaries/zcode-host",
    "binaries/zcode-scheduler",
    "binaries/zcode-agent"
  ],
  "resources": ["binaries/node-runtime", "binaries/host-externals"],
  "icon": [ /* unchanged icons array */ ]
}
```

Build-step to produce correctly-named files (a new `prepare:tauri-sidecars.mjs`, mirroring
the existing `prepare-agent-node-bundle.mjs` pattern). For each sidecar `S` and the
current platform's `<TRIPLE>` (derive from `rustc -vV` / `process.arch`+`process.platform`
the same way `prepare-agent-node-bundle.mjs:36-70` maps os/arch):

```
# Linux/macOS: copy + suffix + exec bit
cp out/host/index.js                       src-tauri/binaries/zcode-host-<TRIPLE>
chmod 755                                  src-tauri/binaries/zcode-host-<TRIPLE>
cp bundled-agents/<platformKey>/glm/zcode.cjs  src-tauri/binaries/zcode-agent-<TRIPLE>
# Windows: add .exe  →  zcode-agent-x86_64-pc-windows-msvc.exe
```

Because the Host/Scheduler are external-dependency ESM, `zcode-host-<TRIPLE>` should be a
**launcher bundle** (`esbuild --bundle out/host/index.js --external:node-pty --external:ssh2
--external:undici … --platform=node --format=esm` with the `#!/usr/bin/env node` banner)
whose `node_modules` siblings are shipped as `resources` and placed on `NODE_PATH` at spawn
(§4). This preserves the `tsup.config.ts:110-122` external contract.

**Cross-build naming for CI**: reuse `ZCODE_TARGET_OS`/`ZCODE_TARGET_ARCH`
(`prepare-agent-node-bundle.mjs:68-69`) and map them to the Rust triple table above.

**Remaining ASSUMPTION** (verify at build time, do not ship on assumption): Tauri
cross-compiles one platform per runner; producing all `<TRIPLE>` binaries at once requires
either per-arch CI jobs or building the JS (platform-independent) once and only renaming
per target — feasible for the JS sidecars because `zcode.cjs` is "同一份 JS 跨平台通用"
(`prepare-agent-node-bundle.mjs:9`), but the native `node-pty` externals ARE arch-specific
(`@lydell/node-pty-linux-x64` / `-linux-arm64` in `package.json:34-35`). **Verification**:
run `pnpm --dir packages/desktop tauri build` once with a trivial sidecar and read the
generated `src-tauri/target/.../bundle` layout + any `externalBin` validation error, which
names the expected file.

## 4. tauri-plugin-shell wiring

### Cargo dependency (`src-tauri/Cargo.toml:14-23`, add alongside `tauri-plugin-dialog`)
```toml
tauri-plugin-shell = "2"
```

### Init (`src-tauri/src/main.rs:22`, chain before `.run`)
```rust
tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_dialog::init())   // already present
    .invoke_handler(/* unchanged */)
```

### Capability (`src-tauri/capabilities/default.json`, currently only `core:default:6`)
Add the sidecar-scoped shell permission. The sidecar identifier in the capability MUST
match the externalBin **stem** (`binaries/zcode-host` → identifier `zcode-host`):
```jsonc
"permissions": [
  "core:default",
  "shell:allow-execute",
  {
    "identifier": "shell:allow-execute",
    "allow": [
      { "name": "binaries/zcode-host",      "sidecar": true },
      { "name": "binaries/zcode-scheduler", "sidecar": true },
      { "name": "binaries/zcode-agent",     "sidecar": true }
    ]
  }
]
```
(`shell:allow-kill` / `shell:allow-stdin-write` may be added if the renderer drives the
child directly; in this design Rust owns the child, so execute+kill on the Rust side is
enough — see §5.)

### Rust spawn snippet — env passes port + secret, stdout/stderr captured for logs
```rust
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandChild;

// window-create hook (see §5 for where this lives)
let (mut rx, child): (_, CommandChild) = app
    .shell()
    .sidecar("zcode-host")?                 // stem, not triple — §3
    .env("ZCODE_WS_PORT", port.to_string())  // ephemeral 127.0.0.1 port  (§6)
    .env("ZCODE_WS_SECRET", &secret)         // per-window shared secret  (§6)
    .env("ZCODE_PROCESS_LABEL", label)       // reuse existing label env  (desktopHostProcess.ts:225)
    .env("NODE_PATH", host_externals_dir)    // node-pty/ssh2/undici siblings (§3)
    // ELECTRON_RUN_AS_NODE is NOT set — the sidecar is a real node bin (§0 asymmetry)
    .spawn()?;

// route child output into the logger (AGENTS.md 日志边界 — never log the secret)
tauri::async_runtime::spawn(async move {
    while let Some(event) = rx.recv().await {
        if let tauri_plugin_shell::process::Event::Stdout(bytes) = event {
            // parse the ready-port line the host prints (see §6 handoff)
        }
    }
});
```
Args/argv for the Host itself: today the Host receives **no argv** — it is `fork`'d with an
empty argv and gets everything via the `InitLocal` MessagePort message
(`desktopHostProcess.ts:219, 578-595`). Under Tauri there is no MessagePort, so the
`InitLocal` payload (`workspacePath`, `workspaceIdentity`,
`zcodeBuiltinProviderConfigFilePath`, `hostId`, `runtimeProcessEnvPatch` —
`HostInitMessage` `:58-76`) must move to **env + argv** or a post-connect WS bootstrap
call. That transport change is `SIDECAR-TRANSPORT.md` §6-step-1 scope, **not** packaging;
flag it so the coding task does not assume the Host boots ready from env alone.

## 5. Lifecycle & orphan prevention

- **Spawn on window-create**, **kill on window-close / app-exit**. Electron auto-killed
  the utilityProcess with main; Tauri does NOT (PORTING.md process-lifecycle trap,
  `SIDECAR-TRANSPORT.md:82-85`). Rust must own the kill.
- `CommandChild` keeps the process alive while held; store it in managed state keyed by
  window label. On the window `Destroy`/`Destroyed` event and on `RunEvent::Exit`, call
  `child.kill()` (`tauri-plugin-shell` exposes `kill()`; `kill_on_drop` is the tokio
  fallback if a raw `Command` is used).
- **Agent grandchild reap**: the Host spawns the Agent, which spawns its own children. The
  existing force-kill already waits **≥3.5s** so the Agent process tree reaps before the
  Host dies (`disposeHostProcess` `Math.max(forceKillDelayMs, 3_500)`,
  `desktopHostProcess.ts:661-671`). Preserve this ordering under Tauri: Rust should send a
  graceful dispose (an RPC/WS "shutdown" or SIGTERM to the Host) and only `child.kill()`
  after the reap window, or accept Host-tree orphaning. The kill chain is
  **renderer-close → Rust kills Host → Host kills Agent → Agent kills grandchildren**, and
  each stage must wait for the prior.
- **Crash-restart policy**: on `Event::Terminated` (non-zero/abnormal) restart the Host
  sidecar with a fresh ephemeral port + fresh secret, capped with exponential backoff
  (e.g. max 3 restarts / 30s) to avoid a crash loop. A restarted Host = a new WS listener;
  the renderer reconnect must be re-handed the new port+secret (§6). Do NOT silently reuse
  the old secret.

## 6. Per-window port + secret — the exact handoff

One window = one Host = one loopback listener = one secret (`SIDECAR-TRANSPORT.md:95-96`).

1. **Port**: Rust allocates an ephemeral free 127.0.0.1 port (bind `:0` and read the port,
   matching the PoC `new WebSocketServer({ host:"127.0.0.1", port:0 })`,
   `poc/ws-rpc-roundtrip.ts:75-81`). Rust owns the choice and passes it down; the Host
   binds that fixed port (rather than binding its own `:0`) so Rust and the renderer both
   know it without a stdout scrape — OR the Host binds `:0` and prints
   `ZCODE_WS_READY <port>` on stdout, which Rust parses (the `SIDECAR-TRANSPORT.md:81`
   "prints its ready port" option). Pick one; the stdout-print adds a race the fixed-port
   option avoids.
2. **Secret**: Rust generates a per-session secret (reuse the existing one-shot host
   capability token flow `hostCapabilities.issue()` / `ZCODE_RPC_HOST_CAPABILITY_HEADER`,
   `packages/server/src/http.ts:321, 340-342`) rather than inventing a new scheme
   (`SIDECAR-TRANSPORT.md:91-94`).
3. **Handoff to the sidecar**: `ZCODE_WS_PORT` + `ZCODE_WS_SECRET` via **env** (§4). The
   Host reads them and gates the WS `upgrade` (reject non-matching token/Origin,
   `SIDECAR-TRANSPORT.md:95-97`).
4. **Handoff to the renderer**: the browser `WebSocket` object cannot set custom headers,
   and `connectViaWebSocket(wsUrl, opts)` (`packages/client/src/websocket.ts:62`) exposes
   only the URL + `onOpenSocket` — so pass **port + secret in the URL**
   (`ws://127.0.0.1:<port>/?token=<secret>`), and the Host must validate the token from the
   query string at upgrade (this differs from the header path used by the web/phone
   remote; document the divergence). The renderer obtains the `wsUrl` via a new
   `IPlatformService` / Rust command (e.g. `get_host_ws_endpoint()`) injected through
   `tauriPlatform.ts` (AGENTS.md: UI hooks access services, never `window.zcode`), replacing
   `connectViaMessagePort`. **Never log the token** (AGENTS.md 日志边界).
5. `connectViaWebSocket` resolves an `IServiceAccessor` (`websocket.ts:97-105`) — the same
   `RemoteServiceAccess` surface the MessagePort path returns, so no renderer service-layer
   change beyond the connect call.

## 7. Minimal next PoC (spawn an echo sidecar, connect, ping)

Smallest runnable proof that sidecar-spawn + WS-connect works end to end, for a later
coding task:

1. Add `tauri-plugin-shell` dep + init + the `shell:allow-execute` sidecar capability (§4).
2. Create ONE trivial sidecar: `src-tauri/poc-echo-host.mjs` — a Node file with
   `#!/usr/bin/env node` that (a) reads `POC_PORT` env, (b) starts the *exact* PoC server
   from `poc/ws-rpc-roundtrip.ts:75-90` (`WebSocketServer` on `127.0.0.1`,
   `wrapWebSocket`→`SocketProtocol`→`ChannelServer`→
   `registerChannel(ISubagentsService.channelName, ProxyChannel.fromService(echo))`), and
   (c) prints `ZCODE_WS_READY <port>` on stdout. No Electron, no `node-pty` — sidesteps the
   Host's native-external problem for the PoC.
3. Add it to `externalBin: ["binaries/poc-echo-host"]`, copy it to
   `src-tauri/binaries/poc-echo-host-<TRIPLE>`, `chmod 755` (§3 naming — this validates the
   rule for real).
4. Rust: on window-create, allocate an ephemeral port, spawn the sidecar with
   `POC_PORT`+`POC_SECRET` env, capture stdout for the ready line.
5. Renderer/`tauriPlatform.ts`: `connectViaWebSocket("ws://127.0.0.1:<port>")` then call
   `subagentsService.list({probe:"hello"})` — the same round-trip the headless PoC already
   verifies (`poc/ws-rpc-roundtrip.ts:92-114`), now driven across the real Rust→sidecar
   spawn boundary.
6. Success = the echo row comes back (`SIDECAR-TRANSPORT.md:118` "one command
   `subagents.list` round-tripping"). This proves naming, exec bit, env handoff, and WS all
   work before touching the real Host externals.

## 8. Ordered checklist + risks

**Checklist**
1. [ ] Run `node scripts/check-workspace-freshness.mjs` (AGENTS.md baseline).
2. [ ] Update `SIDECAR-TRANSPORT.md` spec (§3) to record the resolved triple rule — this
   runbook is the spec; implementation follows AGENTS.md "spec before code".
3. [ ] Add `tauri-plugin-shell` to `Cargo.toml`, init in `main.rs`, extend
   `capabilities/default.json` (§4).
4. [ ] Add `externalBin` + `resources` + flip `bundle.active` in `tauri.conf.json` (§3).
5. [ ] Write `prepare:tauri-sidecars.mjs`: copy/rename/chmod + esbuild launcher bundle for
   Host & Scheduler, keeping the `tsup.config.ts:110-122` externals as external (§3).
6. [ ] Do §7 PoC first (trivial echo sidecar) to confirm naming + spawn + WS on the real
   machine before packaging the full Host.
7. [ ] Implement env/argv `InitLocal` replacement (flagged §4) — cross-task, transport scope.
8. [ ] Wire lifecycle: spawn on create, graceful-shutdown-then-kill on destroy/exit with
   the ≥3.5s reap order (§5); crash-restart with backoff.
9. [ ] Renderer `connectViaWebSocket(wsUrl?token=)` through `tauriPlatform.ts` (§6).
10. [ ] Verify per platform (Linux here; macOS/Windows need CI): bundle layout, exec bits,
   port allocation, orphan check (`pgrep`/Task Manager after close).

**Risks**
- **Size/startup cost**: shipping `node` + `node_modules` externals per platform (Host) is
  the big cost; the Agent's "同一份 JS 跨平台通用" is the exception. Measure vs Electron
  utilityProcess (`SIDECAR-TRANSPORT.md:123`). Mitigation: SEA for the Agent later (§2b).
- **Signing**: sidecar binaries are external executables and must be signed/notarized with
  the app on macOS and on Windows; unsigned copied binaries get killed by Gatekeeper/AV.
  Add signing to the per-platform CI step (not exercised in this Linux runbook).
- **Linux exec bit**: `chmod 755` MUST survive the copy (esbuild/`cp` may drop it). The
  Agent already chmods to `0o755` (`build.mjs:266`); replicate for the launcher.
- **Windows path/quoting**: binaries need the `.exe` suffix in the triple-named file
  (`zcode-agent-x86_64-pc-windows-msvc.exe`); `NODE_PATH`/`resources` paths may contain
  spaces — use Tauri's structured env (`.env()`), never shell-string concat (AGENTS.md
  cross-platform: parameter arrays over shell strings).
- **Port collision across windows**: allocate a fresh ephemeral port per window, never a
  fixed constant (`SIDECAR-TRANSPORT.md:121`).
- **Orphans on crash**: Tauri does not auto-kill children like Electron; rely on
  `kill_on_drop` + explicit `child.kill()` + the reap ordering (§5). Test abnormal-exit,
  not just clean close.
- **InitLocal loss**: the Host will not be "ready from env alone" until the
  MessagePort-payload → env/argv/WS-bootstrap change lands (§4); the PoC deliberately
  avoids it, full-Host packaging does not.
