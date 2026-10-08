# PRINT-PDF-SPIKE.md — Electron→Tauri: `webContents.printToPDF` re-architecture decision

READ-ONLY spike. Grounded in the current Electron print/PDF path. `INVENTORY.md` rates
`webContents.printToPDF` a **HIGH** port-blocker (INVENTORY.md:36, :162, :186): *"Chromium-only;
presentation PDF export must be re-implemented"* → *"none built-in; headless-Chromium/Cairo
re-arch"*. Tauri's system webview (WebKitGTK / WKWebView / WebView2) exposes no portable
print-to-PDF, so this file decides how to reproduce the feature.

Scope of the feature: **PPTX/presentation → PDF export only**. The generic embedded-browser and
other surfaces do not use `printToPDF` (grep of `printToPDF|printToPdf` hits exactly the files
below). The capability is gated behind `IPlatformService.printPageToPdf?` and is **Desktop-only**
by design (platform.ts:520-524, `?:` optional; the UI feature-detects its presence).

## 1. Current flow (what actually runs today)

```
UI (packages/ui, platform-agnostic)
  pptx-preview-viewer.tsx : handleExportPdf()            (L730-767)
    ├─ canExportPdf = Boolean(platform?.printPageToPdf && platform?.saveFile)   (L476)
    ├─ import presentationPdfPrintExport → renderPresentationToPrintHost(document, window.document)
    │     ── mounts a HIDDEN print host in the LIVE renderer DOM            (presentationPdfPrintExport.ts:410-455)
    │        • renders EVERY page (preview is lazySlides; export must be full) (L440-448)
    │        • injects @page CSS sized from doc.pageSize; margins 0          (L319-374, desktopPrintToPdf.ts:21-22)
    │        • font materialization: swaps un-installable / "print-unsafe" fonts (e.g. PingFang)
    │          to a canvas-measured available family so Chromium/Skia does NOT drop glyphs  (L41-42, 199-313)
    │        • waits fonts.ready, decodes <img> (10s cap), 2× rAF for canvas/chart first frame  (L386-404)
    ├─ const printResult = await platform.printPageToPdf()                   (L742)
    │     └─ window.zcode.printPageToPdf()   (preload/index.ts:273-274)
    │          └─ ipcRenderer.invoke("zcode:print-to-pdf")   (channels.ts:142)
    │               └─ main desktopPrintToPdf.ts: event.sender.printToPDF({   (L18-23)
    │                     printBackground:true, preferCSSPageSize:true, margins:0 })
    │                  → Buffer → detached ArrayBuffer   (L25-26)   [serialised to renderer]
    ├─ printHost.dispose()  (release heavy print DOM before the modal save dialog)  (L744)
    └─ await platform.saveFile({ data, suggestedName })                     (L749-752)
          └─ window.zcode.saveFile → ipc "zcode:save-file"                  (preload:270-271, channels:140)
               └─ main desktopSaveFile.ts: dialog.showSaveDialog → writeFile(filePath, Uint8Array)  (L203-218)
                    50 MB cap; ArrayBuffer or remote-URL source             (L12, L192-201)
```

**Key facts that constrain every option:**

- What is printed is a **live, JS/CSS-rendered DOM subtree** — web fonts, decoded raster images,
  and **canvas-drawn charts** — after a deliberate *font-materialization* pass (the entire
  `presentationPdfPrintExport.ts` module exists to work around Chromium/Skia dropping glyphs that
  only the implicit fallback covers at screen time). The output is **vector text** (platform.ts:521).
- Page geometry is **fully data-driven by injected `@page` CSS** (`preferCSSPageSize:true`,
  margins 0). No renderer→main PDF-options channel exists today (main takes no params —
  desktopPrintToPdf.ts:21 comment).
- `printToPDF` prints the **same `webContents`** the print host lives in; the `@media print` CSS
  already hides everything except the host (presentationPdfPrintExport.ts:344-372).
- Delivery is **save-dialog → file write of raw bytes** (`saveFile`), already independent of the
  rendering engine and directly portable to `tauri-plugin-dialog` + `tauri-plugin-fs`.

The hard part is *not* the byte transport — it is **reproducing Chromium's print of that exact
live DOM with the same fidelity**.

## 2. Options evaluated

### (a) Headless-Chromium sidecar (bundle a small Chromium / drive `chrome --headless --print-to-pdf`)

Feed the **already-materialized print host** (serialized live HTML + inlined `@font-face`/web-font
data + rasterized `<img>`/`<canvas>` as data-URLs + computed CSS) to a headless Chromium invoked
from the Node Host sidecar that SIDECAR-TRANSPORT already plans (`tauri-plugin-shell`
`Command::sidecar`, externalBin Node bin).

- **Fidelity: HIGHEST** — same engine as today; identical Skia print output *if* the DOM is
  faithfully transferred. Font-materialization pass runs unchanged (it lives in the renderer).
- **Pros:** cross-platform (Win/mac/Linux uniformly) — directly closes the Linux gap; closest
  behavior parity to Electron; reuses the planned sidecar process model.
- **Cons:** must serialize the live print subtree (canvas.toDataURL, inline fonts, computed styles)
  — a non-trivial "DOM snapshot → self-contained HTML" step; extra process to launch/manage;
  headless print-to-pdf needs print-media + `--no-pdf-header-footer` flags to match current options.
- **Size:** largest. Bundling Chromium ≈ **100–170 MB** per platform (system Chrome: ~0 delta but
  requires it installed). ASSUMPTION: exact delta depends on bundle-vs-external-chrome choice.
- **Complexity:** MEDIUM-HIGH (snapshot serialization + sidecar lifecycle).

### (b) Rust HTML→PDF crates (`printpdf`, `typst`, `weasyprint` via subprocess, `comrak`+headless for MD)

- **Fidelity: LOW for this app.** These render from *markup/source*, not from the app's live,
  laid-out, JS-rendered slide DOM. Canvas charts, embedded web fonts, and the entire
  font-materialization workaround would be **lost** — the exact glyphs/pixels the current code
  fights to preserve. `typst`/`printpdf` don't run the app's CSS/`@page` layout or execute the
  renderer. WeasyPrint (Python subprocess) has partial CSS but ≠ Chromium and adds a Python runtime.
- **Pros:** (b1) `typst`/`printpdf` are native Rust, small, fast — good for *Markdown→PDF* or
  simple templated docs, NOT for pixel-faithful slide export.
- **Cons:** fails the core requirement (reproduce current visual output); extra runtimes; large
  CSS-support divergence to re-qualify every slide theme.
- **Size:** smallest (Rust crates, few MB). **Complexity:** HIGH to reach parity, LOW to ship a
  *degraded* export.

### (c) Per-OS native webview print-to-PDF (WKWebView / WebView2)

- **macOS** WKWebView: `printPDF(configuration:)` (WKPDFConfiguration, macOS 11+). **Windows**
  WebView2: `CoreWebView2.PrintToPdfAsync` / `PrintToPdfResult`. Tauri's `wry` wraps these native
  views, so the handle is reachable in a Rust command.
- **Fidelity: HIGHEST-but-native** — it prints the *same* webview the print host lives in, exactly
  like Electron does today, so DOM snapshotting (a's cost) is avoided; `@media print` CSS +
  injected `@page` already scope what prints.
- **Gap: WebKitGTK on Linux has NO print-to-PDF API** (INVENTORY.md:36, :201 note the Linux
  webview gaps). So (c) is Win+mac only → Linux still needs (a) or (d).
- **Pros:** no bundled Chromium on Win/mac, minimal size delta, closest to current architecture.
- **Cons:** three code paths, `unsafe`/FFI to reach `wry`'s native view, per-OS print-media
  emulation flag differences, and Linux left uncovered.
- **Size:** ~0 delta (uses the OS webview already present). **Complexity:** MEDIUM (per-OS FFI) but
  does NOT solve Linux alone.

### (d) De-scope: PDF export Electron-only / server-side

- Keep `printPageToPdf` **optional** (it already is) and leave it `undefined` on Tauri/Linux at
  launch; UI feature-detection (`canExportPdf`, pptx-preview-viewer.tsx:476) then simply hides the
  button — **no crash, graceful degradation already built in.** Alternatively route export to a
  server-side headless Chromium.
- **Pros:** zero port risk now; matches the existing capability-gated design.
- **Cons:** feature regression for Tauri/Linux desktop users; server-side adds infra, latency, and
  can't reach the local renderer's live DOM (would need the slide source re-rendered server-side).

## 3. Recommendation

**Two-tier, fidelity-first:**

1. **Primary = (c) native webview print-to-PDF on Windows (WebView2) and macOS (WKWebView).**
   Rationale: it prints the *identical live DOM* the current code already prepares (the
   font-materialization + full-page print host stays 100% reusable — it is engine-agnostic,
   renderer-side CSS/JS). Lowest size, closest behavior parity, no DOM serialization, and no new
   bundled runtime. The existing `@page`/`@media print` scoping (presentationPdfPrintExport.ts) maps
   directly onto native print configuration.

2. **Linux fallback = (a) headless-Chromium sidecar**, fed the serialized print-host subtree, invoked
   through the already-planned Node Host sidecar (`tauri-plugin-shell`, SIDECAR-TRANSPORT.md:33, :80-81).
   This is the only option that closes the WebKitGTK gap with acceptable fidelity; the
   canvas-chart / web-font fidelity risk means pure-Rust crates (b) are unacceptable for slides.

**Rejected:** (b) as a *slide*-export engine — fidelity risk too high (loses canvas charts, the
whole font-materialization workaround, and app CSS). (`typst`/`printpdf` remain valid later for a
separate *Markdown→PDF* feature, which does not exist today.)

**Why not (a)-everywhere:** bundling Chromium on Win/mac trades ~150 MB and a second browser
runtime for fidelity already provided by the resident webview. Use the free native path where it
exists; pay the Chromium cost only on Linux where there is no alternative.

**Fidelity risk (explicit):** the hard part is JS/CSS-rendered slides — canvas-drawn charts, web
fonts, and the print-unsafe-font substitution (presentationPdfPrintExport.ts:41-42, :199-313).
Any engine other than a Chromium/WK/WebView2 print of the *live* DOM will regress this. The
Linux (a) path MUST transfer the post-materialization DOM (canvas→dataURL, inlined `@font-face`,
serialized computed style), not the slide source, or output will diverge from the current baseline.

## 4. Minimal PoC sketch (measure before committing)

**Native (c):**
- Windows (Rust command, `wry`→WebView2): call `CoreWebView2.PrintToPdfAsync(path, options)` with
  `PreferCSSPageSize = true`, `Margin = 0`, `PrintBackground = true`; return file path.
- macOS (Rust command, `wry`→WKWebView): `webView.printPDF(configuration:)` (WKPDFConfiguration:
  `preferCSSPageSize = true`, `paperSize`/margins matching injected `@page`); data → file.
- UI: swap `platform.printPageToPdf()` internals only; renderer print host + `saveFile` unchanged.

**Linux (a):**
```
# From Node Host sidecar, given serialized print-host HTML (self-contained: inlined fonts, img/canvas dataURLs, CSS):
# write it to a temp file, then:
chrome --headless=new --no-pdf-header-footer --print-to-pdf=<out.pdf> file://<tmp.html>
# (or puppeteer-core: page.emulateMediaType('print'); page.pdf({ preferCSSPageSize:true, printBackground:true, margin:0 }))
```

**What to measure (side-by-side vs current Electron baseline):**
- **Bundle size delta** per platform (native path vs bundled Chromium).
- **Output fidelity** vs today: pixel-diff exported PDFs for a slide deck containing (1) canvas
  charts, (2) CJK + Latin web fonts, (3) an image-heavy deck, (4) a deck using a print-unsafe font
  (PingFang). Compare glyph survival, page count, page size, and vector-vs-raster text.
- **Time-to-PDF** (native vs headless process spawn) and memory during full-deck render.

## 5. Effort + risk + fallback

| Path | Effort | Risk | Notes |
|---|---|---|---|
| (c) native Win/mac | M (2 FFI commands) | MED | depends on `wry` exposing the native view; print-media flag parity |
| (a) headless Chromium (Linux) | M-H | MED-HIGH | DOM-serialization fidelity is the risk; sidecar lifecycle |
| (b) Rust crates | H for parity / L for degraded | HIGH | regresses charts/fonts; only viable for MD→PDF later |
| (d) De-scope | XS | LOW | graceful-hide already wired via optional `printPageToPdf?` |

**Overall:** MEDIUM effort, MEDIUM risk. The renderer-side print-host machinery is fully portable
(it's engine-agnostic CSS/JS); only the final `printToPDF` byte-producing call is platform-specific.

**Fallback ladder:** if (c) native FFI proves unstable or (a) fidelity regresses, fall back to **(d)
de-scope** — ship the button only on platforms with a verified path and leave `printPageToPdf`
`undefined` elsewhere (UI already feature-detects it, so no crash and no partial/low-fidelity export).
