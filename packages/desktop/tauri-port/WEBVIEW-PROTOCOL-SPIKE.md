# WEBVIEW-PROTOCOL-SPIKE: Page-Bridge Injection (#4) + Session/Media Protocol (#5) on Tauri

Read-only spike. Grounded in the files cited below (paths + line numbers). This doc
decides the two remaining `INVENTORY.md` port-blockers #4 and #5
(`INVENTORY.md:187-190`, table rows 163-165, 36-40).

Scope note: `packages/desktop/src-tauri` and `tauriBridge.ts` are owned by another
agent and were **not** read or touched here. Tauri/wry capability claims are grounded
in current docs (see Sources) and marked **ASSUMPTION** where not repo-verifiable.

Cross-ref: the *embedded in-DOM browser* (CDP, viewport emulation, in-DOM `<webview>`)
is decided in [`BROWSER-CDP-SPIKE.md`](./BROWSER-CDP-SPIKE.md). Read the two together:
#4 injection is the *soft* half of that same webview story (page↔app messaging), and #5
is the *storage/network* half. This doc does NOT re-decide the browser chrome; it reuses
that spike's conclusion that Tauri webviews are **native OS views, not DOM children**.

---

## BLOCKER #4 — Main-world `executeJavaScript` / CSS injection into webview content

### 4.1 What it does today

There are **two distinct injection consumers** with very different port difficulty. They
are frequently conflated, so the decision MUST be made per-consumer.

**(A) Coding-plan purchase bridge — targets a FIRST-PARTY page.**

Two cooperating layers:

1. *Preload, runs inside the guest* — `packages/desktop/src/preload/codingPlanWebview.ts`.
   - Gated by `isTrustedCodingPlanBridgeLocation()` (line 34-62; enforced at line 77) which
     only enables the bridge for the trusted coding-plan origin and its payment callback.
   - `contextBridge.exposeInMainWorld(NATIVE_BRIDGE_KEY, …)` (line 78) publishes a native
     bridge that calls `ipcRenderer.sendToHost(CodingPlanWebviewChannels.PurchaseComplete)`
     (line 81) and `ipcRenderer.send(PlatformChannels.OpenExternal)` (line 94).
   - `contextBridge.executeInMainWorld({ func, args })` (line 104-160) installs
     `window.zcodeBridge` in the **page's main world** exposing `getLang()`,
     `getReportContext()`, `onLangChange(cb)`, `openExternal()`. It reads globals
     `window.__zcodeLang__` (`LANG_VAR`, line 30) and `window.__zcodeReportContext__`
     (`REPORT_CONTEXT_VAR`, line 32) and listens for the `zcode-coding-plan-lang-change`
     `CustomEvent` (line 31, 145) — all three of which the **app injects from outside**
     (see next bullet), which is why the bridge must live in the *main* world (it shares
     one `window` with the page scripts; the file's own comment, lines 19-23, says so).

2. *App-side injection driver* — `packages/ui/src/settings/CodingPlanEmbeddedWebviewDialog.tsx`
   (the `<webview partition="persist:zcode-coding-plan">` is created at line 501):
   - `webview.executeJavaScript(clear + authScript, true)` (line 199-202) — the auth script
     from `codingPlanEmbeddedWebview.ts:151` `createCodingPlanAuthInjectionScript` writes
     provider OAuth tokens + `zcodejwttoken` into guest `localStorage` (lines 182-188),
     toggles theme classes (194-198), sets `window.__zcodeLang__` (202),
     `window.__zcodeReportContext__` (204), persists report context to `localStorage` (205),
     and dispatches `zcode-coding-plan-auth-ready` (206-208).
   - Locale change: `createCodingPlanLangInjectionScript` (dialog line 225-226; builder
     `codingPlanEmbeddedWebview.ts:285`) rewrites `window.__zcodeLang__` and dispatches
     `zcode-coding-plan-lang-change`.
   - Cosmetic CSS: `createCodingPlanScrollbarHideScript` (dialog line 298) injects a
     `<style id="zcode-coding-plan-hide-scrollbar">` DOM node (builder lines 254-269) — i.e.
     the "insertCSS" role here is done through the DOM, NOT Electron's `webContents.insertCSS`.

   **First-party verdict (this decides feasibility):** the target origin is ZCode's own
   site. `isTrustedCodingPlanWebviewOrigin` (`packages/shared/src/zcodeEndpoint.ts:104`)
   returns true only for `DEFAULT_ZCODE_ENDPOINT_ORIGIN = "https://zcode.z.ai"`
   (`zcodeEndpoint.ts:3`) or the configured runtime endpoint origin, plus loopback *only*
   when `VITE_ZCODE_E2E_STORE_BRIDGE=1`. The injected globals (`zcodeBridge`,
   `__zcodeLang__`, `__zcodeReportContext__`, `zcode-coding-plan-*-ready`) are **read by the
   website's own scripts**, so the remote page already *cooperates* with the bridge.
   PayPal is the only truly third-party hop, and the bridge is deliberately **off** there
   (callback path gated at `codingPlanWebview.ts:47-49, 76`).

**(B) Embedded-browser JS-dialog bridge — targets ARBITRARY third-party pages.**

- `packages/desktop/src/preload/embeddedBrowserJavaScriptDialog.ts` uses
  `contextBridge.executeInMainWorld` (line 39-109) to **monkey-patch `window.alert` /
  `window.confirm`** across the whole iframe tree (`installFrameTree`, line 72-93; a
  `MutationObserver` re-patches dynamically inserted `about:blank` iframes, line 100-104),
  routing them to a native dialog via `ipcRenderer.sendSync(PlatformChannels.EmbeddedBrowserJavaScriptDialog)`
  (line 21). This guest is the in-app browser (`persist:zcode-embedded-browser`) and loads
  arbitrary web content — the page does **not** cooperate. This is the genuinely hard case,
  but note it is *the same webview surface already de-scoped* in BROWSER-CDP-SPIKE.md.

### 4.2 Tauri options

Tauri has **no arbitrary main-world injection into OS-webview content**. The relevant
building blocks (docs: `WebviewBuilder`, wry):

- **`initialization_script` / `with_initialization_script`** (wry `WebViewBuilder`,
  exposed through Tauri `WebviewWindowBuilder`) — a script evaluated in the page context
  *before page scripts run*, at creation time. **This is main-world, not isolated.**
  Caveat (wry 0.40 changelog, Sources): *"On macOS, disable initialization script injection
  into subframes"* → subframe coverage differs per-OS. **A**
- **`Webview::eval` / `evaluate_script`** (JS `@tauri-apps/api/webview` `eval`, Rust
  `WebviewWindow::eval`) — run JS in the loaded page (roughly `executeJavaScript`).
  No return-value round-trip in the current API (fire-and-forget) — so any
  "read a value back from the page" pattern needs a re-architect. **A**
- **IPC / events** — `@tauri-apps/api/core` `invoke` + `@tauri-apps/api/event`
  `emit`/`listen`. `postMessage`-style app↔page messaging, but the page must **opt in**
  (load `@tauri-apps/api` or the injected `__TAURI__` IPC) — a remote page cannot unless
  you control it or inject the shim.

Option matrix for the two consumers:

| Approach | Coding-plan (A, first-party) | Embedded browser (B, third-party) |
| --- | --- | --- |
| (a) IPC-only opt-in page bridge (postMessage ↔ `ipc`) | ✅ feasible — page is ZCode-owned; publish `window.zcodeBridge` via a small init script that forwards to `invoke`/`emit`. Website already reads these globals. | ❌ requires the remote page to cooperate — arbitrary sites will not. |
| (b) Inject only into pages you control | ✅ this *is* the case (origin is `zcode.z.ai`) — treat as first-party, ship an official website-side Tauri adapter alongside the Electron one. | ❌ by definition the browser loads content you don't control. |
| (c) `initialization_script` on the WebviewWindow | ✅ can predefine `window.zcodeBridge` + globals before page scripts run, and dispatch the `auth-ready` event; covers the boot-time handoff. Locale/token updates at runtime still need `eval` + event emit. | ⚠️ technically injects into any loaded page (main-world) — could re-patch `alert/confirm`, **but** macOS subframe caveat + per-OS drift make it fragile; and B's host webview is already being re-scoped in CDP spike. |

### 4.3 Fidelity / behavior risks (what to measure)

- **Timing/ordering.** Today the driver injects *after* `dom-ready` (`dialog` line 199, and
  the comment at line 218-219: early `executeJavaScript` throws pre-attach). With
  `initialization_script` the bridge exists *before* page scripts — a *behavior change*:
  website code that waits for `zcode-coding-plan-auth-ready` must still fire it after the
  app has the tokens (which arrive at runtime, not at creation). Measure: does the website
  read `zcodeBridge`/`__zcodeReportContext__` at load or only on the `auth-ready` event?
  (Need the website source — **ASSUMPTION** it is event-driven, per line 206 dispatch.)
- **No eval return channel.** `getLang()`/`getReportContext()` in the current design are
  *page→bridge reads of already-injected globals* (synchronous in-page), NOT app→page
  round-trips, so `eval`'s no-return limitation does NOT block them. Confirm no other call
  site relies on `executeJavaScript` returning a value into the app. (Grep shows the coding
  -plan driver discards return values: `await` then only catches — dialog 199, 226, 401.)
- **Token injection = security boundary.** Writing OAuth tokens into guest `localStorage`
  (builder 182-188) plus the partition isolation must stay scoped to the trusted origin.
  Measure that the Tauri init script is registered only for the coding-plan window and that
  the PayPal/navigation-away path cannot inherit it (mirror the `isTrusted…` gate).
- **`alert`/`confirm` patching (B)** relies on cross-frame main-world access — highest risk;
  defer to the CDP spike's webview decision.

### 4.4 Recommendation, effort, risk, 1-day PoC (#4)

- **Recommendation — split the two consumers:**
  - **#4-A (coding plan): FEASIBLE, port it.** It is **first-party** (origin `zcode.z.ai`),
    so the "requires remote cooperation" objection does not apply — ZCode owns the website.
    Use **`initialization_script`** to define `window.zcodeBridge` and forward
    `notifyPurchaseComplete`/`openExternal` to `invoke`; keep runtime credential/locale push
    on `Webview::eval` + `emit('zcode-coding-plan-*-…')`. Add a small first-party Tauri
    adapter on the website side (it already keys off these exact globals/events). Map the
    preload's `sendToHost`/`ipc-message` (`channels.ts:383`) to a Tauri event channel.
  - **#4-B (embedded browser dialog patching): defer / de-scope** with the rest of the IAB —
    do not attempt arbitrary third-party main-world patching on Tauri webviews. Whatever
    survives of the browser (BROWSER-CDP-SPIKE.md) re-decides dialog handling; likely accept
    the WKWebView/WebKitGTK native `alert`/`confirm` (lose the native-dialog parity).
- **Effort:** #4-A **M** (one init script + event plumbing + a coordinated website-side flag);
  #4-B **XL / blocked** and bundled with the CDP decision.
- **Risk:** #4-A **LOW-MED** (timing/ordering + first-party coordination); #4-B **HIGH**
  (per-OS init-script/subframe drift, macOS caveat).
- **1-day PoC (#4-A):**
  1. Tauri `WebviewWindow` loading the coding-plan URL (or a local mock that reads
     `window.zcodeBridge.getLang()`/`getReportContext()` and dispatches a purchase event).
  2. Register `with_initialization_script` defining `zcodeBridge` that forwards to
     `invoke('coding_plan:*')`; confirm the mock page sees the bridge *before* its scripts run.
  3. Drive `eval` + `emit('zcode-coding-plan-lang-change')` at runtime and confirm the page's
     `onLangChange` fires. Pass = bridge visible pre-page-script, one event round-trip works,
     `invoke` reaches Rust. If the page reads globals only at load (not on event), the
     init-script timing change is validated as safe.

---

## BLOCKER #5 — Chromium session partitions + `zcode-media://` Range/seek protocol

### 5.1 What it does today

**(A) Seekable media file protocol** — `packages/desktop/src/main/localMediaPreviewProtocol.ts`.
- Global privileged scheme before app ready:
  `protocol.registerSchemesAsPrivileged([{ scheme: 'zcode-media',
  privileges: { standard: true, secure: true, stream: true } }])` (line 138-143), called at
  `main/index.ts:169`.
- Handler: `protocol.registerFileProtocol('zcode-media', …)` (line 154-173). It parses
  `zcode-media://local/preview?path=…` (URL shape built in
  `packages/shared/src/platform.ts:95-101`), validates `hostname === "local"`,
  `pathname === "/preview"` and `isPathAuthorized(path)` (line 160-167), then returns the
  **raw absolute path** to Chromium's **native file loader** (line 168 `callback(path)`).
- **Critical, and the crux of the port:** the comment at line 151-153 states they *deliberately
  avoided* `protocol.handle(Response)` because *"Electron 41 无法为本地音视频提供稳定的
  seekable range，手工返回 Range 还会被媒体栈判为不可播放"* — i.e. they **lean on Chromium
  to synthesize Range/206/seek**. The `standard`+`stream` privileges (comment 132-136) exist
  specifically so MP4s whose `moov` atom sits after `mdat` are read correctly. **Tauri has no
  native file loader — the Range/206/seek semantics must be reimplemented in the Rust handler.**
- Authorization registry (`createLocalMediaPreviewPathRegistry`, line 47-130): main only
  registers paths the Host already validated via workspace/session/attachment checks
  (comment 43-46, closes an arbitrary-file-read hole); TTL 30 min / LRU 256 (line 40-41),
  `realpath` canonicalization (98), re-check of canonical path + regular-file on every
  `isAuthorized` (114-117).
- Registered on **defaultSession**: `installLocalMediaPreviewProtocol(session.defaultSession.protocol, …)`
  (`index.ts:1604-1606`).

**(B) Bootstrap protocol** — `packages/desktop/src/main/browserView/browserRestoreBootstrapProtocol.ts`.
- `protocol.handle(scheme, async () => …)` (line 21-27) returns a *delayed empty* `Response`
  (`text/html`) after up to 60 s (line 3, 22-25). Used only so a restore-pending webview has
  a `src` without committing navigation before `pageState` is ready (comment 10-13). Scheme
  derived from `BROWSER_VIEW_RESTORE_BOOTSTRAP_URL`. Registered on the embedded-browser
  partition (`index.ts:1609-1610`). This one is trivial: no Range, constant body.

**(C) Session partitions / isolation + network policy.**
- Two persistent partitions: `EMBEDDED_BROWSER_PARTITION = "persist:zcode-embedded-browser"`
  (`browserDataManager.ts:30`) and `CODING_PLAN_WEBVIEW_PARTITION = "persist:zcode-coding-plan"`
  (`desktopCommandHandlers.ts:43`). `<webview partition=…>` set in UI at
  `BrowserViewportSurface.tsx:129` and `CodingPlanEmbeddedWebviewDialog.tsx:501`.
- `session.fromPartition(...)` usage: proxy/cert policy per-session
  (`desktopNetworkPolicy.ts:66`), Chrome-data import/clear (`browserDataManager.ts:123,216`),
  partition storage wipe (`desktopCommandHandlers.ts:140`), media/restore protocol scoping
  (`index.ts:1604,1610`).
- Network policy per partition (`desktopNetworkPolicy.ts:51-90`): `setProxy` (103) +
  `closeAllConnections` (104); **`defaultSession` → fallback `direct`** (never use system
  proxy; 61-62), **embedded-browser → fallback `system`** (follow OS proxy; 70-72). Cert:
  embedded browser can `accept-all` (`createInsecureCertificateVerifyProc`, 125-129) or a
  custom-CA fingerprint chain match (153-200); `defaultSession` keeps Chromium default
  verification. This is a **cookie jar + proxy + TLS-trust isolation** that Chromium owns.

### 5.2 Tauri options

**(A) Range/seek media → `register_asynchronous_uri_scheme_protocol`** (Tauri `Builder`,
confirmed API: docs.rs `tauri::Builder::register_asynchronous_uri_scheme_protocol`, and the
official `examples/streaming/main.rs` which explicitly comments *"if the webview sent a range
header, we need to send a 206 in return"* — Sources). Handler shape (Rust):

```rust
// zcode-media://localhost/preview?path=<abs>  (must map the custom host/path form)
tauri::Builder::default()
  .register_asynchronous_uri_scheme_protocol("zcode-media", move |_ctx, request, responder| {
      // 1. Parse query: path = url query param "path".
      // 2. Authorization: ask the Rust port of createLocalMediaPreviewPathRegistry
      //    (TTL 30m / LRU 256 / realpath canonicalization) — reject unknown → 400.
      //    MUST be the same allow-list the Host populated; do NOT trust renderer URL.
      // 3. Open file, get len (std::fs::File + metadata).
      let len = /* file size */;
      // 4. Parse "Range: bytes=start-end" (may be absent, open-ended, or suffix "bytes=-N").
      let (start, end) = parse_range(request.header("range"), len)?; // default 0..len-1
      // 5. Build a 206 (or 200 when no Range header) with:
      //      status      = 206
      //      Accept-Ranges: bytes
      //      Content-Range: bytes {start}-{end}/{len}
      //      Content-Length: end - start + 1
      //      Content-Type: <mime from ext>   // video/mp4 etc.
      // 6. Body = the byte window (seek to start, read len window), handed to responder.
      let response = http::Response::builder()
          .status(206)
          .header("accept-ranges", "bytes")
          .header("content-range", format!("bytes {}-{}/{}", start, end, len))
          .header("content-length", (end - start + 1).to_string())
          .header("content-type", mime)
          .body(window_bytes)
          .unwrap();
      responder.send(response);
  });
```

Notes:
- `register_asynchronous_uri_scheme_protocol` (not the sync one) is required because the
  authorization `realpath`/registry and file reads are blocking — do them on a blocking task
  and reply via `responder` (mirrors the existing `async` authorize in the TS registry).
- Must also handle `HEAD`, multi-range is generally NOT needed (Chromium media sends single
  range), and the **full-file `200` when no `Range`** so a non-seekable first read still works.
- **`zcode-media://` is a non-standard scheme.** Tauri/WebKitGTK and WKWebView treat custom
  schemes as "privileged-ish" only if registered; you may need to also register it as a
  *safe/secure* scheme at the wry layer so the media stack grants it stream/canvas access.
  Confirm per-OS. **A**
- **WebKitGTK / GStreamer codec caveat (Linux):** HTML5 `<video>` on WebKitGTK decodes through
  **GStreamer**; MP4/H.264 playback needs the right GStreamer plugins installed on the host
  (`gst-libav`/`gst-plugins-good`, `qtdemux`). A moov-after-mdat file that Chromium tolerated
  via `standard+stream` may still fail to *seek* if the demuxer can't get the index — this is
  an environment dependency Electron hid. **A** (flag as the top #5 risk).

**(B) Bootstrap protocol** → `register_uri_scheme_protocol` returning a fixed empty `Response`
with a delayed reply (or simpler: load the restore webview with an `about:blank`/data URL and
navigate once `pageState` is ready, dropping the artificial delay). Low risk, no Range needed.

**(C) Partition isolation:**
- Tauri has **no `session.fromPartition`**. Per-webview isolation = separate
  `WebviewWindow`/`Webview` each with its own **`data_directory`** (window/webview builder
  `data_directory`/`DataDirectory`), giving a private cookie jar + LocalStorage/IndexedDB per
  partition (`persist:zcode-coding-plan` and `persist:zcode-embedded-browser` each become a
  window with a dedicated data dir). Clearing = delete that dir / use the JS/asset protocol's
  clear APIs. **A** for exact `data_directory` semantics.
- **Proxy:** no webview proxy API on WKWebView/WebKitGTK. Route through
  **`tauri-plugin-http`/`reqwest`** only for *app* HTTP (the `defaultSession` direct/system
  distinction, custom CA) — that does NOT affect what the *webview* fetches. Webview-level
  proxy for the embedded browser has **no first-class Tauri path** → either OS-level proxy or
  de-scope. Custom CA trust: bundle via the platform store; `accept-all-insecure` for a webview
  is not exposed on macOS/Linux. **A** — treat as a real gap.
- **Cookies/JS-dialog isolation** that Chromium partitions gave for free now needs the
  per-window data-dir + the CDP-spike's session model.

### 5.3 Fidelity / behavior risks (what to measure)

- **Seek correctness for `moov`-after-`mdat` MP4** — the exact case Electron's comment
  (151-153) fought. Measure: does the Rust 206 handler make a forward-*and*
  backward-seekable MP4 play and scrub in (a) WKWebView, (b) WebView2, (c) WebKitGTK?
- **Range edge cases:** open-ended `bytes=100-`, suffix `bytes=-500`, `bytes=0-` (whole file →
  still 206 not 200), invalid ranges → `416`. Electron's native loader handled these; a hand
  roll must match.
- **HEAD requests** (media stacks probe with HEAD) → must return headers, empty body, correct
  `Content-Length`/`Accept-Ranges`.
- **Content-Type/MIME** sniffing for the extension (Electron file loader inferred it).
- **Linux GStreamer codec availability** (see above) — measure on the actual target distro,
  not just your dev box.
- **Proxy/TLS-trust parity** for the embedded browser partition — measure whether losing
  webview-level proxy/insecure-cert override breaks the "self-signed internal test site" use
  case that `desktopNetworkPolicy.ts` exists to serve.
- **Auth allow-list must not regress:** the whole point of the registry (comment 43-46) is to
  prevent renderer-driven arbitrary file read. Any Tauri handler that trusts the `path` query
  param without re-checking the Host-populated allow-list reintroduces that CVE. Measure that
  the Rust registry mirrors TTL/LRU + `realpath` re-validation.

### 5.4 Recommendation, effort, risk, 1-day PoC (#5)

- **Recommendation:**
  - **#5-A media protocol: port it, but as a real Rust Range/206 handler.** Do NOT try to find
    a "native loader" equivalent — there is none; implement the streaming handler above,
    reusing the ported authorization registry verbatim in spirit. Accept that **Linux
    playback becomes a GStreamer/codec environment dependency** (document + possibly bundle
    codec guidance) — this is the fidelity cliff.
  - **#5-B bootstrap: trivial** — a fixed-response scheme handler, or restructure to
    `about:blank` + programmatic navigate; kill the 60 s timer.
  - **#5-C partitions:** map each `persist:*` to a dedicated-`data_directory` `WebviewWindow`.
    Keep app HTTP on `tauri-plugin-http`/reqwest for the `direct` vs `system` proxy + custom-CA
    policy. **Flag webview-level proxy + insecure-cert override as a likely gap** to resolve in
    the browser decision (BROWSER-CDP-SPIKE.md) — the coding-plan partition does *not* need
    insecure certs, so #4-A's window is unaffected; only the embedded browser is.
- **Effort:** #5-A **M-HIGH** (careful Range + per-OS media testing); #5-B **LOW**;
  #5-C **M** (data-dir wiring) **+ HIGH for the embedded-browser proxy/TLS** (may be de-scoped).
- **Risk:** **MED-HIGH** overall — highest for Linux MP4 seek (GStreamer) and for the
  security-sensitive path authorization. Matches `INVENTORY.md:40` "MED-HIGH".
- **1-day PoC (#5-A):**
  1. Rust `register_asynchronous_uri_scheme_protocol("zcode-media", …)` implementing Range →
     206 + `Accept-Ranges`/`Content-Range`, `HEAD`, and no-range → 200.
  2. Serve two fixtures: an MP4 with `moov` **before** `mdat` and one with `moov` **after**
     `mdat` (faststart vs non-faststart), plus one large enough to force backward seeks.
  3. Load in each Tauri webview (Win/Mac/Linux); assert play + forward/backward scrub +
     duration metadata. Pass = both MP4s seek on all three; failure on Linux pins the GStreamer
     caveat as a product-support decision (bundle codecs vs. document requirement).

---

## Combined webview story (cross-ref)

- **First-party windows** (coding-plan `persist:zcode-coding-plan`, main app UI) → port cleanly
  on Tauri: `initialization_script` + `invoke`/`emit` for the page bridge (#4-A), dedicated
  `data_directory` for isolation (#5-C). No CDP, no arbitrary injection needed.
- **Media preview** (`zcode-media://`) → a hand-written Rust Range/206 handler (#5-A); the one
  hard cross-OS risk is Linux MP4 seek via GStreamer.
- **Third-party embedded browser** (#4-B dialog patching, and its proxy/insecure-cert partition,
  and the `zcode-browser-restore://` bootstrap) → this is exactly the surface BROWSER-CDP-SPIKE.md
  de-scopes. Its webview-level proxy/TLS-trust needs (#5-C) and arbitrary main-world injection
  (#4-B) share the same fate: **no byte-parity on Tauri system webviews**; resolve as a product
  de-scope, not a re-implementation.

Reading together, the two spikes agree: **the port is viable for first-party windows + media, and
the residual blockers all collapse into the single embedded-browser decision** in
[`BROWSER-CDP-SPIKE.md`](./BROWSER-CDP-SPIKE.md).

---

## Files read (this spike)

- `packages/desktop/src/preload/codingPlanWebview.ts`
- `packages/ui/src/settings/CodingPlanEmbeddedWebviewDialog.tsx`
- `packages/ui/src/settings/model-provider-section/codingPlanEmbeddedWebview.ts`
- `packages/shared/src/zcodeEndpoint.ts`, `packages/shared/src/platform.ts`,
  `packages/shared/src/channels.ts`
- `packages/desktop/src/preload/embeddedBrowserJavaScriptDialog.ts`
- `packages/desktop/src/main/localMediaPreviewProtocol.ts`
- `packages/desktop/src/main/browserView/browserRestoreBootstrapProtocol.ts`
- `packages/desktop/src/main/desktopNetworkPolicy.ts`
- `packages/desktop/src/main/browserDataManager.ts`
- `packages/desktop/src/main/desktopCommandHandlers.ts`, `packages/desktop/src/main/index.ts`
- `packages/ui/src/browser-use/BrowserViewportSurface.tsx`
- `packages/desktop/tauri-port/INVENTORY.md`, `BROWSER-CDP-SPIKE.md`

Sources (Tauri/wry capability grounding):
- [`tauri::Builder::register_asynchronous_uri_scheme_protocol` (docs.rs)](https://docs.rs/tauri/latest/tauri/struct.Builder.html)
- [Tauri `examples/streaming/main.rs` (Range → 206 pattern)](https://github.com/tauri-apps/tauri/blob/dev/examples/streaming/main.rs)
- [`tauri::webview::WebviewBuilder` (docs.rs)](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewBuilder.html)
- [wry 0.40 changelog — "disable initialization script injection into subframes" (macOS)](https://v2.tauri.app/zh-cn/release/wry/v0.40.0/)
- [Tauri v2 webview JS API](https://v2.tauri.app/zh-cn/reference/javascript/api/namespacewebview/)
