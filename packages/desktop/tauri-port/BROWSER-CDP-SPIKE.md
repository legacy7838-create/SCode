# BROWSER-CDP-SPIKE: Embedded In-App Browser on Tauri — Go/No-Go

Read-only spike. Grounded in the files cited below. This feature is flagged in
`INVENTORY.md` (§ "TOP PORT-BLOCKERS" #1/#2, line 60-62, 160-161, 182-185) as the
**single largest port blocker**. This doc decides whether that is a stop-sign for
the whole Electron→Tauri port or a de-scoping problem.

Scope note: `packages/desktop/src-tauri` and `tauriBridge.ts` are owned by another
agent and were NOT read or touched here. Tauri/wry capability claims below are from
ecosystem knowledge and marked **ASSUMPTION** where not verifiable in this repo.

---

## 1. Feature inventory: what the embedded browser DOES today

The in-app browser (IAB) is **still wired and user-facing**, even though the
CUA/agent-browser plugins were removed. `INVENTORY.md` (line 177-178) explicitly
notes "residual CUA/browser leftovers still present … the whole
`main/browserView/` subsystem."

Mount point is live: `packages/ui/src/app-shell/AnimatedSidePanePanel.tsx:1220`
renders `<HumanBrowserView>`, which is a thin wrapper over `UnifiedBrowserView`
(`packages/ui/src/browser-use/HumanBrowserView.tsx:6`).

| Capability | Status | Where | CDP-dependent? |
| --- | --- | --- | --- |
| Tabs / guest registry, per-scope ownership | LIVE | `browserView/browserGuestManager.ts` (2356 lines) | No (registry) |
| In-DOM page rendering (`<webview>` guest pixels) | LIVE | `browser-use/UnifiedBrowserView.tsx` (renders `<webview>` in DOM, lines 33-37, 117-118) | No (plain webview) |
| Navigation / history / reload / stop / zoom | LIVE | `UnifiedBrowserView.tsx`, guest `navigationHistory`, `setZoomFactor` | No |
| Free-resize **viewport emulation** (responsive preview) | LIVE | `browserGuestManager.ts` `setTabViewport`/`reset` → `Emulation.*` | **YES (CDP)** |
| Residency suspend/restore + tab recovery persistence | LIVE | `browserTabResidencyCoordinator.ts`, `browserTabRecoveryStore.ts`, `restoreSuspendedGuest` | No (uses CDP `Page.enable` on re-attach) |
| Synthetic mouse/wheel **input** (agent-driven) | PARTIALLY DEAD | `browserGuestManager.ts:1431` still scales `Input.dispatchMouseEvent`; no live agent caller found | **YES (CDP)** |
| **Chrome localStorage import** | LIVE | `chromeLocalStorageManager.ts` `importChromeLocalStorage` ← `browserDataManager.ts:152` | **YES (CDP)** |
| **Chrome cookie import** | LIVE | `chromeLocalStorageManager.ts` `readChromeCookiesWithHelper` | **YES (CDP)** |
| Agent **page screenshot** | DEAD | `browserGuestManager.ts:1822` "agent CDP 截图已移除"; `hasRunningRequestForTab` stubbed `false` (1817-1819) | (was CDP) |
| Window screenshot (error-feedback) | LIVE but unrelated | `desktopMainIpcHelpers.ts:78` `webContents.capturePage()` — full-window PNG, not guest | No |
| **Video recording** | DEAD | only `preload/browserVideoRecorder.ts` stub exists; no main handler / no `RECORDER_PORT_CHANNEL` consumer found in `main`/`renderer` | — |

### Exact CDP commands used (from the code)

`browserGuestManager.ts` — via `guest.debugger.attach("1.3")` + `debugger.sendCommand`:
- `Emulation.setDeviceMetricsOverride` (lines 1098, 1140, 1193, 1349) — viewport emulation; params include `width/height/deviceScaleFactor/mobile/dontSetVisibleSize/scale` (`buildViewportMetricsOverride`, 236-255)
- `Emulation.clearDeviceMetricsOverride` (1113, 1177)
- `Page.enable` (1335) — session-state replay on re-attach
- `Input.dispatchMouseEvent` (1431) — scale-compensated synthetic input (caller path largely dead)

`chromeLocalStorageManager.ts` — two CDP transports: a WebSocket transport to a
spawned headless Chrome (`--remote-debugging-port=0`, `--headless=new`, 399-428)
and an Electron `webContents.debugger` transport (`createElectronCdpTransport`, 255-277). Commands:
- `Page.enable`, `Runtime.enable`, `Fetch.enable` + `Fetch.fulfillRequest`/`Fetch.failRequest` (blank-document interception, 279-304)
- `Page.navigate` + `Runtime.evaluate` (`location.origin`, `Object.entries(localStorage)`, localStorage write) (306-329, 456, 611)
- `Network.enable` + `Storage.getCookies` (559-565)

`webContents.debugger` is also gated in `desktopWindowChrome.ts`: `webviewTag: true`
(line 587) and `will-attach-webview` (line 640) which forces a fixed preload +
sandbox/context-isolation on every guest.

---

## 2. Tauri options per capability (decision matrix)

Two architectural truths that dominate everything:

1. **No in-page `<webview>`.** Tauri/wry webviews are native OS views/windows, not
   DOM children. The current model — guest pixels composited *inside* the renderer
   DOM and overlaid by DOM float layers (toolbar, resize handles, JS dialogs,
   `UnifiedBrowserView.tsx:35`) — is not reproducible with any Tauri system webview.
   (This is the same conclusion as `INVENTORY.md:38` "No multi-webview in main webview".)
2. **No unified CDP.** The three capabilities that are CDP-dependent
   (viewport emulation, synthetic input, Chrome localStorage/cookie import) split by OS.

Legend: ✅ feasible · ⚠️ partial/hacky · ❌ not available · **A** = ASSUMPTION (ecosystem knowledge, not repo-verified).

| Capability | Option A: wry/Tauri v2 multi-webview | Option B: OS CDP/inspector | Option C: dedicated Chromium/CEF sidecar | Option D: de-scope (external browser) |
| --- | --- | --- | --- | --- |
| In-DOM embedded render | ❌ all OS — webview is a native view, not DOM child. Win/Mac `Webview` can share a window; **Linux WebKitGTK = one webview per window (Tier-2)** **A** | n/a | ✅ Win/Mac/Linux — offscreen-render Chromium into a DOM `<canvas>/<img>` stream (OS-independent pixels) | ❌ (loses embedding) |
| Separate OS-window browser | ✅ all OS via `WebviewWindowBuilder` (not embedded; changes UX) | n/a | ✅ | ✅ |
| Viewport emulation (`Emulation.setDeviceMetricsOverride`) | ❌ no equivalent API on WKWebView/WebKitGTK **A** | Win ✅ via WebView2 CDP (`--remote-debugging-port` / `ICoreWebView2EnvironmentOptions`); Mac ❌ (WKWebView has no device-metrics CDP); Linux ❌ (WebKitGTK no CDP) **A** | ✅ full CDP `Emulation.*` | ❌ |
| Synthetic input (`Input.dispatch*`) | ⚠️ native send-event only, not CDP **A** | Win ✅ WebView2 CDP; Mac ⚠️ WebKit remote-inspector (not CDP, limited input); Linux ❌ **A** | ✅ full CDP `Input.*` | ❌ (hand off to real browser) |
| Chrome localStorage import | n/a | Already uses a **spawned headless Chrome over CDP** (portable) — independent of the app's own webview; only the *target write* uses Electron `webContents.debugger` (`chromeLocalStorageManager.ts:599`). On Tauri, write target must move to the sidecar's own session **A** | ✅ read+write both in Chromium sidecar over CDP | ⚠️ user does it in their browser |
| Chrome cookie import (`Storage.getCookies`) | n/a | Same: read path is headless-Chrome CDP (portable); write-to-partition must be reimplemented | ✅ | ⚠️ |
| Page screenshot (agent) | DEAD already — drop | Win ✅; others hard | ✅ (already removed, no parity needed) | n/a |
| Video recorder | DEAD — no wiring; drop | — | — | n/a |

Notes:
- **Windows is the only OS where CDP-on-the-app-webview is plausibly viable**
  (WebView2 exposes CDP via remote-debugging port / `CallDevToolsProtocolMethod`)
  — but even then it is a *separate native webview*, not in-DOM.
- The Chrome-data import read path is effectively **port-agnostic already**: it
  spawns the user's installed Chrome headless and speaks raw CDP over WebSocket
  (`chromeLocalStorageManager.ts:174-253, 393-428`). Only the Electron-target write
  (`createElectronCdpTransport`, 255-277) needs a Tauri-side substitute.
- macOS WebKit "remote inspector" is the Apple Inspector Protocol, **not** CDP;
  no `Emulation` device-metrics and poor `Input` parity → ❌/⚠️.
- Linux WebKitGTK has no CDP and the worst multi-webview support (Tier-2).

---

## 3. Recommendation

**Byte-parity is NOT feasible.** The current IAB is defined by two things Tauri
system webviews cannot both provide: (a) guest pixels composited *inside* the DOM
and overlaid by app UI, and (b) a uniform CDP surface for viewport emulation +
input + storage. No single Tauri approach restores both across Win/Mac/Linux.

Honest reduced-scope plan:

**Tauri v1 ships:**
- Embedded browser as a **`WebviewWindow`** (separate OS window) for plain browsing
  (nav / history / zoom / residency) — the majority of the *human* IAB value,
  feasible on all three OS. Loses in-DOM embedding and DOM float overlay.
- **Chrome localStorage/cookie import** via the existing headless-Chrome CDP helper
  (already portable); re-point the write target to a Tauri-managed Chromium/partition
  session. Keep it in the Node/Rust sidecar, not the webview.
- Free-resize **viewport emulation only on Windows** (WebView2 CDP). On macOS/Linux,
  the responsive-preview feature is **dropped** (WebKit has no device-metrics CDP).

**Deferred / de-scoped:**
- Agent synthetic input automation — already partly dead post-CUA; do not rebuild.
- Agent page screenshot + video recorder — dead, delete with the port.
- In-DOM embedded webview + DOM overlay — architecturally incompatible; if product
  insists, the *only* path is a **Chromium/CEF offscreen sidecar** streaming frames
  into a DOM surface (Option C) — large binary cost, own maintenance.

**Per-OS reality:**
- **Windows:** most feasible; WebView2 CDP can carry viewport + (if needed) input for
  a `WebviewWindow` browser.
- **macOS:** hardest for emulation/automation (WKWebView, no CDP).
- **Linux:** hardest overall — WebKitGTK, no CDP, Tier-2 multi-webview (one per window).

If the product requires the *current* embedded, in-DOM, viewport-emulated browser with
automation parity on all three OS, the realistic answer is **a dedicated Chromium/CEF
sidecar** — i.e. you would be shipping Chromium anyway, which negates a primary Tauri
motivation (binary size / system-webview reuse).

---

## 4. Effort, risk, and the go/no-go signal

- **Effort:** XL. `browserGuestManager.ts` (2356 LOC) + `chromeLocalStorageManager.ts`
  (706) + `UnifiedBrowserView.tsx` (1012) + the residency/recovery subsystem, all keyed
  to Electron `webContents` handles and CDP. The whole `will-attach-webview`/guest-id
  model has no Tauri analog.
- **Risk:** CRITICAL for parity; HIGH even for the reduced `WebviewWindow` scope (Linux
  multi-webview + cross-OS CDP divergence, and the codebase's documented UAF lifecycle
  guards — `browserGuestManager.ts:1019-1076, 1896-2017` — exist precisely because of
  Electron `<webview>`+CDP teardown fragility; a new host means re-deriving them).
- **Go/no-go for the port:** This feature **alone justifies staying on Electron** IF the
  embedded in-DOM + CDP-emulated browser is a hard product requirement. If product
  accepts a reduced `WebviewWindow` browser (separate window, no Linux/macOS viewport
  emulation, no agent automation), the port is viable and the blocker downgrades to
  "known feature regression," not "stop." Decision gate is therefore a **product** call,
  not a purely technical one.

---

## 5. What to spike next (1-day PoC)

Two cheap de-risking experiments; run before committing to any port path.

1. **Linux — second webview load + JS eval (wry/Tauri).** Create a `WebviewWindow`
   pointing at a local page; confirm (a) navigation loads, (b) `evaluate_script`
   (equivalent of `executeJavaScript`) returns a value, (c) whether opening a *second*
   `Webview` inside the same window works or is rejected by WebKitGTK (expect Tier-2
   failure — this validates the "one webview per window" constraint). Record which of
   `UnifiedBrowserView`'s guest methods survive.
2. **Windows — CDP attach on the app's own WebView2.** Launch with WebView2, attach
   via `--remote-debugging-port` (or `CallDevToolsProtocolMethod`), then send
   `Emulation.setDeviceMetricsOverride` (resize a page to a fixed CSS viewport) and
   `Input.dispatchMouseEvent` (click). Confirm both round-trip. If yes, Windows viewport
   emulation parity is real; if no, Windows drops to the same reduced scope as Mac/Linux.

Pass criterion for a "Tauri browser v1": PoC-1 (a)+(b) green on Linux, PoC-2 viewport
green on Windows. Failure of PoC-2 collapses viewport to de-scope across all OS.

---

*Files read:* `packages/desktop/src/main/browserView/browserGuestManager.ts`,
`packages/desktop/src/main/chromeLocalStorageManager.ts`,
`packages/desktop/src/main/desktopWindowChrome.ts`,
`packages/desktop/src/main/desktopBrowserViewIpc.ts`,
`packages/desktop/src/main/browserDataManager.ts`,
`packages/desktop/src/main/desktopMainIpcHelpers.ts`,
`packages/desktop/src/preload/browserVideoRecorder.ts`,
`packages/ui/src/browser-use/{UnifiedBrowserView,HumanBrowserView}.tsx`,
`packages/ui/src/app-shell/AnimatedSidePanePanel.tsx`,
`packages/desktop/tauri-port/INVENTORY.md`.
