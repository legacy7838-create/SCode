# TEST-HARNESS.md — Language-neutral parity harness for the Electron→Tauri port

> Scope: design only. This file defines how the port (Electron kept alongside Tauri)
> is *verified*. No parity claim may be made without harness output, per
> `PLATFORM-ADAPTER-PLAN.md` §5 ("No parity claim without harness output on
> Linux/macOS/Windows where applicable") and AGENTS.md Phase 1 ("tests are the
> contract"). Read-only relative to source: implementing this harness is follow-up work.

Ground rule from the playbook (Phase 1): **a pass count that drops, or a skip that
grows, without an explicitly reviewed reason, blocks the port.** Everything below exists
to make that gate measurable and cheap to run.

---

## 1. Baseline: what exists today, and the gap

### 1.1 Real test files (four, all `node:test`)

The checked-in suite is 4 black-box tests. They use Node's built-in runner, not a
framework:

- `packages/services/test/importedClaudeRecovery.test.ts`
- `packages/services/test/nonCliAcpRetirement.test.ts`
- `packages/services/test/providerConfigMigration.test.ts`
- `packages/ui/test/nonCliAcpRetirement.test.ts`

`importedClaudeRecovery.test.ts:1-15` imports `test from "node:test"` and
`assert from "node:assert/strict"`, and parameterizes over both client modes
(`"desktop-continuous"` and `"web-remote-replayable"`). This is the shape the harness
should extend: runtime-agnostic assertions driving real `@zcode/shared` protocol
schemas (`zcodeSessionStateSnapshotSchema`) against real service code.

### 1.2 Absent infrastructure (confirmed by search)

- **No test framework config**: no `vitest.config.*`, `jest.config.*`,
  `playwright.config.*`, or `wdio.conf.*` anywhere outside `node_modules`.
- **No `test` npm script** in the root `package.json` or any `packages/*/package.json`.
  The 4 tests are run ad-hoc (via `tsx`/`node --test`), not by a scripted entry point.
- **No CI**: there is no `.github/` directory at all; the only automated gate is the
  husky/`verify:pre-push` path, which runs `lint` + `architecture:check`, **not tests**.
- **No `vitest`/`jest`/`playwright`/`@playwright/test`/`webdriverio` dependency** is
  declared. `tsx` is available as a root `devDependency` (`package.json:72`);
  `ts-node` only in `packages/rpc`.

### 1.3 E2E hooks exist but the E2E harness is not in-tree

The desktop main process carries first-class E2E affordances, which means some driver
suite is expected to exist (possibly external to this checkout — **ASSUMPTION: the
Chromedriver/WebDriver E2E suite these env vars target is not present in the repo**):

- `packages/desktop/src/main/index.ts:176` appends `--remote-debugging-port=9229` in dev;
  the comment above it (lines 172-175) references *Chromedriver* taking over the port and
  a *WebDriver `deleteSession`* on teardown.
- Env surface: `ZCODE_E2E_COVERAGE`, `ZCODE_E2E_ARTIFACT_DIR`, `ZCODE_E2E_RUN_ID`,
  `ZCODE_E2E_RUNTIME_LOG_DIR`, `NODE_V8_COVERAGE`.
- Renderer store bridge: `packages/desktop/src/renderer/src/main.tsx:59-67` lazily imports
  `@zcode/ui/e2e-store-bridge` → `packages/ui/src/lib/e2eStoreBridge.ts`, gated on
  `VITE_ZCODE_E2E_STORE_BRIDGE === "1"`. This exposes Zustand stores to a driver.
- Coverage flush: `packages/desktop/src/main/e2eCoverage.ts` and
  `packages/desktop/src/host/e2eCoverage.ts`.

**Gap summary:** the *runtime seams* for a UI harness are wired (CDP port, store bridge,
artifacts, coverage), but there is no runner, no CI, no driver suite, and no Tauri-side
equivalent. A Tauri renderer has no `--remote-debugging-port`, so the existing E2E hooks
do not transfer to the target runtime as-is (see §3 Layer C).

---

## 2. Three testable layers (grounded)

| # | Layer | Seam / files | Runs headless? | Parity relevance |
|---|-------|--------------|----------------|------------------|
| 1 | **Agent stdio JSON-RPC** | Protocol schemas `packages/shared/src/zcode-protocol/index.ts` (`zcodeProtocolRequestSchema/Response/Notification/Message`, `ZCODE_PROTOCOL_NAME="ZCode Protocol"`, `ZCODE_PROTOCOL_VERSION=1`, wire v3); client `packages/services/src/zcode-agent/zcodeProtocolClient.ts` + `zcodeProtocolTransport.ts` | Yes | Runtime-agnostic: identical over Electron utilityProcess and Tauri sidecar. |
| 2 | **Localhost WS RPC (Local Host)** | `packages/rpc` (`SocketProtocol`, `ChannelServer`, `ProxyChannel`, binary `serialization.ts`); `packages/client` (`connectViaWebSocket`, `connectViaMessagePort`, `connectViaProtocol`); PoC `packages/desktop/tauri-port/poc/ws-rpc-roundtrip.ts` | Yes | `SIDECAR-TRANSPORT.md` §6 step 5 names `subagents.list` round-trip as the smallest end-to-end proof. |
| 3 | **Renderer UI / platform adapter** | Contract `IPlatformService` `packages/shared/src/platform.ts:504-919` (~60+ members incl. optional); impls `desktopPlatform.ts` (`createDesktopPlatform`) and Tauri `tauriBridge.ts`/`tauriPlatform.ts` (owned by another agent) | Partly (Layer B headless; Layer C needs a webview) | The port's parity contract is "same `IPlatformService` method → same observable behavior". |

---

## 3. Layered harness design (same assertions against BOTH runtimes)

The core idea: **one assertion set, two targets.** Each layer's test module receives a
`runtime` fixture and a `platform`/`transport` under test built for that runtime.
Nothing in an assertion names `electron` or `tauri` — only the fixture factory does.

### Layer A — transport / protocol (highest ROI, no GUI)

Black-box tests that drive layer 1 and 2 without any webview:

- **A1 protocol conformance:** feed sample request/notification/response frames through
  `zcodeProtocolMessageSchema` (`.parse` / `.safeParse`) and assert both runtimes' framing
  produces schema-identical objects. Catches wire-version / nullability drift.
- **A2 stdio round-trip:** spawn the Agent CLI over stdio (`zcodeProtocolTransport`),
  send a request (e.g. `initialize`, a `session.*` flow, a
  `zcodeProtocolNotifications` method such as `process/resourceSample`), assert the
  response matches the protocol result schema.
- **A3 WS RPC round-trip:** lift the existing PoC
  (`packages/desktop/tauri-port/poc/ws-rpc-roundtrip.ts`) into a real test. It already
  wires `wrapWebSocket → SocketProtocol → ChannelServer → registerChannel` server-side and
  uses the real `connectViaWebSocket` client with `ISubagentsService.channelName`, asserting
  `subagents.list({probe:"hello"})` echoes back. This *is* the `SIDECAR-TRANSPORT.md` §6.5
  smallest-proof assertion; make it the seed for Layer A3.

Layer A must run identically whether the host transport is MessagePort (Electron) or
localhost WS (Tauri) — that is exactly the claim being tested, so the assertion body must
not branch on transport.

### Layer B — platform adapter conformance (the parity contract)

A single shared conformance suite (`platform.spec.ts`) parameterized over two
`IPlatformService` instances: `createDesktopPlatform(...)` and the Tauri factory
(`tauriPlatform`, per `PLATFORM-ADAPTER-PLAN.md`). For each method it calls it on **both**
impls with the **same inputs** and asserts **equal observable behavior** — equal return
shape, equal error class, equal event emission. This directly gates the phase table in
`PLATFORM-ADAPTER-PLAN.md` §5.

Coverage tiers (map to plan phases):

- **P0 identity/locale** (safe to assert now): `getSystemLocale`, `getDeviceId`,
  `isLocalDevelopmentRuntime` — already round-trip green via `tauriBridge.ts`
  (`get_system_locale`, `get_device_id`). These are the cheapest Layer-B seeds.
- **P1 window/chrome/zoom/menu + `executeDesktopCommand`**: the menu-command slice
  (`packages/desktop/src/main/desktopCommandHandlers.ts:476` `executeDesktopCommand`,
  driven by `DesktopCommandIds` in `desktopApplicationMenu.ts`: `NewTask`, `OpenWorkspace`,
  `CloseActiveContext`, `ToggleFullScreen`, `ZoomIn`/`ZoomOut`/`ResetZoom`, `ShowAbout`,
  `CheckForUpdates`, `OpenChangelog`, `ToggleDevTools`, `SetZCodeEndpointCustom`,
  `ResetZCodeEndpoint`, `ToggleZCodeStdioTapDevProxy` — ~12-14 commands) plus menu events
  (`onNewTask`/`onOpenWorkspace`/`onFocusTab`/`onNewTab`/`onCloseActiveContextRequest`).
  Assert the Tauri bridge commands (`window_minimize`, `window_maximize`, `window_unmaximize`,
  `window_toggle_fullscreen`, `window_close`, `window_set_focus`, `window_is_maximized`)
  produce the same observable window-state transitions as the Electron impl.
- **P2 dialogs/fs** (`show_open_dialog`/`show_save_dialog`/`show_message_dialog` ↔
  `selectDirectory`/`selectFile`/`saveFile`): assert equal result shape; `saveFile` binary
  equality (see §6).
- **Remote-heavy methods** (`connectRemote`, `onRemote*`, `isDockerAvailable`,
  `listWSLDistros` …): **blocked behind Layer A3 / WS sidecar** (plan P7/P8 require the
  localhost-WS transport to be live first).

Optional methods must be treated explicitly: the suite records whether a member is
implemented, so a missing optional method fails the parity gate unless the plan phase
declares it intentionally deferred (e.g. `getPathForFile` deferred to P4 spike per
`PLATFORM-ADAPTER-PLAN.md` P2).

### Layer C — UI smoke (per-OS, webview-level)

Only after A+B are green. Runs the SAME user-facing scenario assertions against each
runtime's webview. The driver differs by OS **and by runtime engine** — this is the
harness's hardest constraint:

| Runtime | Engine | Driver mechanism | CDP available? |
|---------|--------|------------------|----------------|
| Electron | Chromium | Chrome DevTools Protocol via the already-wired `--remote-debugging-port` (Playwright `chromium.connectOverCDP` or `_electron`; store bridge via `VITE_ZCODE_E2E_STORE_BRIDGE=1`) | Yes |
| Tauri / Windows | WebView2 (Chromium) | W3C WebDriver + WebView2's `--remote-debugging` for Edge (msedgedriver), or Appium/WinAppDriver; Playwright-over-CDP is possible only when WebView2 debugging is enabled | Yes (Chromium) |
| Tauri / macOS | WKWebView | Appium + macOS driver / `safaridriver`-style WebKit automation | **No — WKWebView exposes no CDP** |
| Tauri / Linux | WebKitGTK | WebKitGTK's built-in WebDriver (`WebKitWebDriver` / wpe web-driver), W3C WebDriver protocol | **No — no CDP** |

Consequences for the design:

1. **Layer C must be written against the W3C WebDriver common subset only** — locators,
   clicks, text readback, `executeScript`. Any CDP-only capability (tracing domains,
   `Network.*`, screenshot clip params) is available on Electron/Windows but NOT on
   macOS/Linux Tauri, so such assertions must be marked runtime-capped or excluded from the
   parity gate.
2. Electron's existing store bridge (`packages/ui/src/lib/e2eStoreBridge.ts`) is the
   reference for asserting state; the Tauri renderer needs an equivalent bridge wired
   through `tauriPlatform` before Layer C can assert state (not just DOM) — flag as a
   prerequisite, **ASSUMPTION: not yet built**.
3. Playwright is the recommended authoring layer (it abstracts CDP for Electron/WebView2),
   but macOS/Linux Tauri will fall through to Appium/WebDriver; the harness must accept two
   backend implementations of the same scenario file.

---

## 4. Runner + CI matrix, and the parity gate

### 4.1 Runner

Use `node:test` (matches the 4 existing tests) driven by `tsx` for A1/A2 and the Rust-side
invocation glue. Add a root script so the suite is no longer ad-hoc (currently absent):

```
"test": "tsx --test packages/*/test/**/*.test.ts"        # existing unit baseline
"test:harness:electron": "... Layer A + B against desktopPlatform (host via MessagePort)"
"test:harness:tauri":    "... Layer A + B against tauriPlatform (host via localhost WS)"
"test:parity":           "run both, diff results, enforce the gate"
```

Rust units keep the plan §5 gate: `cargo check && cargo test && cargo clippy -- -D warnings
&& cargo fmt --check` on `packages/desktop/src-tauri` (owned by another agent — harness
only consumes its `cargo test` output). `tsc` on `tauriBridge.ts`/`tauriPlatform.ts` is a
prerequisite gate, not part of the JS runner.

### 4.2 Headless launch

- Layer A: fully headless (spawn Agent CLI / WS host in-process; no window).
- Layer B: headless — `IPlatformService` impls are constructed directly in a Node/ts test
  context; window commands that need a live webview are stubbed to record calls, or pushed
  to Layer C.
- Layer C Electron: launch with `remote-debugging-port` (already default in dev,
  `index.ts:176`) and `ZCODE_ENV=test`; can run under `xvfb-run` on Linux CI.
- Layer C Tauri: launch `pnpm dev:tauri` (`packages/desktop/package.json`, `tauri dev`);
  Linux/macOS under a virtual display; the webview driver attaches to the Tauri window.

### 4.3 CI matrix (os × runtime)

```
matrix: { os: [ubuntu-latest, macos-latest, windows-latest], runtime: [electron, tauri] }
exclude: none — but Layer C driver backend is chosen by (os, runtime) per §3 table.
```

macOS and Linux Tauri Layer C must use the WebKit/Appium WebDriver backend (no CDP);
Windows Tauri and all Electron may use CDP/Playwright. Until an OS's Tauri driver exists,
that cell runs Layer A+B only and Layer C is reported **SKIPPED (reason: no driver)**,
never silently green.

### 4.4 Parity pass-count gate (the acceptance rule)

`test:parity` produces two machine-readable result sets (JUnit/`node:test` TAP) and asserts:

1. **Equal pass count** for every test present in both runtimes; target may not have fewer
   passes than source.
2. **Zero new skips.** A skip present in Electron but absent in Tauri (or vice-versa) fails
   unless annotated with a phase-deferral reason from `PLATFORM-ADAPTER-PLAN.md` §5.
3. **Zero behavior diffs in Layer B**: for each `IPlatformService` member exercised, the
   recorded (return-shape, error-class, event-signature) tuples must match between impls,
   modulo OS-allowed differences (e.g. path separators, `listWSLDistros` being Windows-only
   → that member is expected-`undefined` off Windows and the assertion is OS-capped, not
   skipped).

Any violation blocks the parity claim. This operationalizes AGENTS.md Phase 1.

### 4.5 Actual runnable gate today (grounded, updated)

The full cross-runtime `test:parity` (§4.4) is the target, but not all of it is wired yet. The
concrete, currently-executed gate per code slice is:

- `pnpm test:tauri` → runs `test:tauri:layer-a` + `test:tauri:layer-b` + `test:tauri:rust`.
  Current: layer-a 11 pass / 1 skip (a4 sidecar needs a built `zcode-echo`; skipped headless),
  layer-b 14 pass (adapter conformance), rust 18 pass.
- `cargo clippy --manifest-path packages/desktop/src-tauri/Cargo.toml -- -D warnings` and
  `cargo fmt --check` (Rust style/lint).
- `npx tsc --noEmit -p packages/desktop/tsconfig.renderer.json` for the **bridge + adapter**.

**Critical caveat (verified):** the repo's canonical `pnpm typecheck` is
`tsc -b packages/rpc … packages/desktop/tsconfig.host.json` — it does **NOT** include
`tsconfig.renderer.json`, so it never type-checks `tauriBridge.ts` / `tauriPlatform.ts` / the
`renderer/src` files. `pnpm typecheck` passing (EXIT 0) is necessary-but-NOT-sufficient for the
bridge/adapter: the renderer project MUST be checked separately via `tsconfig.renderer.json`, or
the seam's types go unverified (a false-green). `tauriPlatform.ts` deliberately imports the
`@zcode/shared` types (`IPlatformService`, `Locale`, `DesktopTitleBarTheme`) so the renderer `tsc`
is the real contract check for the adapter.

**Current green evidence (every AGENTS gate run on the port):** `pnpm typecheck` EXIT 0; `pnpm lint`
EXIT 0 with **0 warnings in any `tauri*` / layer-a / layer-b file** (the 61 workspace warnings are all
pre-existing in `packages/ui`, none from the port); `tsconfig.renderer.json` 0 errors for
`tauriBridge.ts` / `tauriPlatform.ts` / `tauriHostConnection.ts`; `pnpm test:tauri` = layer-a
11 pass/1 headless-skip, layer-b 16 pass (b1 adapter 14 + b2 transport 2), rust 18 pass.

---

## 5. Smallest first harness to build NOW (recommended)

Build **Layer A + Layer B (P0 tier)** first. Both are GUI-free, transfer the existing
`node:test` style, and directly verify the two port seams: the transport drop-in
(`SIDECAR-TRANSPORT.md`) and the platform contract (`PLATFORM-ADAPTER-PLAN.md`).
Layer C is deferred until the Tauri store bridge exists (§3 C.2).

### 5.1 Concrete file layout

```
packages/desktop/tauri-port/test/
├── harness.config.ts                       # runtime fixture registry: {electron, tauri}
├── fixtures/
│   ├── electron.ts                         # buildHostTransport() via MessagePort + createDesktopPlatform()
│   └── tauri.ts                            # buildHostTransport() via localhost WS + tauriPlatform factory
├── layer-a/
│   ├── a1-protocol-frames.test.ts          # zcodeProtocolMessageSchema conformance
│   ├── a2-stdio-roundtrip.test.ts          # Agent CLI over stdio (zcodeProtocolTransport)
│   └── a3-ws-subagents.test.ts             # promoted from poc/ws-rpc-roundtrip.ts (subagents.list)
├── layer-b/
│   ├── platform.spec.ts                    # shared conformance body, parameterized per runtime
│   ├── p0-identity.test.ts                 # getSystemLocale / getDeviceId (seed, already green in tauriBridge)
│   ├── p1-window-commands.test.ts          # executeDesktopCommand / window_* equivalence
│   └── helpers/capabilities.ts             # records which IPlatformService members are implemented
├── parity/
│   └── gate.ts                             # diff two TAP/JUnit result sets, enforce §4.4
└── report/                                 # (transient) per-run TAP; not committed (AGENTS.md)
```

`a3-ws-subagents.test.ts` should literally reuse the PoC wiring (`WebSocketServer(host:"127.0.0.1",port:0)`
→ `wrapWebSocket` → `SocketProtocol` → `ChannelServer` → `registerChannel(ISubagentsService.channelName, …)`
→ `connectViaWebSocket`), converting `process.exit`/`console.log` into `assert` under `node:test`.

### 5.2 Sample assertions

Layer A3 (parity of the WS seam — must pass identically on both fixtures; note the
assertion never references `electron`/`tauri`):

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { forRuntimes } from "../harness.config.ts"; // [{name:"electron",build}, {name:"tauri",build}]

for (const rt of forRuntimes()) {
  test(`subagents.list round-trips over the host transport (${rt.name})`, async () => {
    const { client, dispose } = await rt.buildHost();   // MessagePort vs WS is rt-local detail
    try {
      const res = await client.subagentsService.list({ probe: "hello" });
      assert.equal(Array.isArray(res), true);
      assert.equal(res[0].ok, true);
      assert.deepEqual(res[0].received, { probe: "hello" });
    } finally {
      await dispose();
    }
  });
}
```

Layer B P0 (platform contract equivalence — the actual parity check):

```ts
for (const rt of forRuntimes()) {
  test(`${rt.name}: getDeviceId is a stable non-empty string`, async () => {
    const p = rt.buildPlatform();               // createDesktopPlatform vs tauriPlatform
    const id = await p.getDeviceId();
    assert.equal(typeof id, "string");
    assert.ok(id.trim().length > 0);
  });
}

// Cross-runtime diff, asserted once:
test("electron and tauri expose the same P0 member set", () => {
  assert.deepEqual(
    supportedMembers("electron"),               // from helpers/capabilities.ts
    supportedMembers("tauri"),
  );
});
```

---

## 6. Binary / stream edge (why A3 must assert deep-equal, not just truthiness)

`SIDECAR-TRANSPORT.md` §5 confirms the RPC framing is already binary
(`serialization.ts` tags `DataType.Buffer=2`/`VSBuffer=3`; nested `Uint8Array` base64-marked
and restored). So `saveFile`/`printToPdf`/screenshot-style payloads survive WS unchanged —
but this only holds if both runtimes use the same `serialization.ts`. Layer A3 and Layer B
P2 must therefore assert **byte-level equality** on a binary round-trip (e.g. a `Uint8Array`
of known bytes echoed through the channel), not `ok:true`, or a framing regression in the
Tauri sidecar path will pass a truthiness-only check.

---

## 7. How the existing slices map onto this harness

| Existing slice | Harness coverage |
|----------------|------------------|
| The ~12 `executeDesktopCommand` menu commands (`desktopCommandHandlers.ts:476`, `DesktopCommandIds` in `desktopApplicationMenu.ts`) and the Tauri window commands in `tauriBridge.ts` (`window_minimize/maximize/unmaximize/toggle_fullscreen/close/set_focus/is_maximized`) | **Layer B / `p1-window-commands.test.ts`** — same window-state transition + menu-event emission asserted on both `IPlatformService` impls. |
| `tauriBridge.ts` identity/meta commands (`get_app_version`, `get_system_locale`, `get_device_id`, `get_platform_info`, `get_app_name`, `get_download/documents_directory`) | **Layer B / P0 tier** — the immediate, already-round-trip-green seed; assert equal observable values across `desktopPlatform` and `tauriPlatform`. |
| `tauriBridge.ts` dialog commands (`show_open_dialog`, `show_save_dialog`, `show_message_dialog`) | **Layer B / P2** — result-shape + binary equality vs Electron (`selectFile`/`saveFile`). |
| WS PoC (`poc/ws-rpc-roundtrip.ts`) | **Layer A / `a3-ws-subagents.test.ts`** — promoted from a `console.log`+`process.exit` script into a `node:test` assertion that runs against both MessagePort and WS fixtures. |
| Agent stdio protocol (plan P0 `getZCodeStdioTapDevState`; `zcodeProtocolClient.ts`) | **Layer A / `a2-stdio-roundtrip.test.ts`** — headless Agent CLI framing/schema conformance. |
| invoke()⇄command seam integrity (as of slices 1–26) | **Layer A / `a5-contract.test.ts`** — static, headless, cross-language: 6 invariants (command↔wrapper 1:1 both ways, ≥40-command false-green tripwire, camelCase invoke arg keys, command↔`generate_handler` registration both ways). Catches the slice-18 drift class + the defined-but-unregistered twin automatically. |
| "Electron stays intact" import-safety invariant | **Layer A / `a6-bridge-import.test.ts`** — imports `tauriBridge.ts` under a Tauri-less `window` and asserts it throws nothing + `isTauriRuntime()` probes `false` (then `true` once `__TAURI_INTERNALS__` is present): proves zero import side effects so the bridge is safe to load in an Electron renderer. |
| Renderer UI (Electron store bridge, CDP port) | **Layer C** — deferred until the Tauri store bridge exists; W3C-WebDriver-subset-only so the same scenario runs on CDP (Electron/Windows-WebView2) and WebKit (macOS/Linux Tauri). |

---

## 8. Open items / ASSUMPTIONs

- **ASSUMPTION:** a Chromedriver/WebDriver E2E suite targeting the `ZCODE_E2E_*` / store-bridge
  hooks exists but is not checked into this repo (no spec files, no config, no `.github/`).
- **ASSUMPTION:** the Tauri `IPlatformService` implementation and a Tauri-side store bridge are
  built by the agent owning `src-tauri`/`tauriBridge.ts`; Layer B P1/P2 and all of Layer C
  depend on them.
- Unknowns to confirm before building: exact Tauri webview driver per OS (Appium vs
  `WebKitWebDriver` vs msedgedriver), and whether WebView2 debugging can be enabled for
  Playwright-over-CDP on Windows.
- The harness adds a `test`/`test:parity` root script that currently does not exist; this is
  design, not applied change.
