# CI-PACKAGING.md — Electron→Tauri build / sign / notarize / CI pipeline map

> READ-ONLY planning deliverable. No source, config, or `src-tauri` file was modified.
> Every claim is tied to a file I read; anything not verifiable in-repo is marked
> **ASSUMPTION**. Secrets are listed as NAMES only — never values, certs, or keys.
> Cross-references (do not duplicate): sidecar naming → `SIDECAR-PACKAGING.md`;
> updater signing/manifest → `UPDATER-SPIKE.md`; CI test matrix → `TEST-HARNESS.md` §4.

---

## 0. What "release pipeline" means today (Electron path)

The desktop package is built through a chain of `packages/desktop/package.json` scripts
(lines 16-24) that a CI job runs in order. The `bundle` script is the actual
electron-builder invocation. No `.github/` or `.gitlab/` config is checked into this
checkout (`TEST-HARNESS.md:39-40` confirms "No CI … no `.github/`"), so the orchestration
env vars below are read from the scripts themselves; the CI YAML that sets them is
external (**ASSUMPTION**: a GitLab CI pipeline exists per references such as
`prepare-prebuilds.mjs:59-60` `.gitlab/ci/00-workflow.yml`, but it is not in-tree).

Ordered pipeline (from `packages/desktop/package.json:16-24`):

| Step | Script | Source | Produces |
| ---- | ------ | ------ | -------- |
| `prepare:build-meta` | `scripts/build-metadata.mjs` | — | build metadata (version/hash) consumed by builder |
| `prepare:runtime-assets` | `scripts/prepare-runtime-assets.mjs` | orchestrator | fans out to the four `prepare:*` steps below |
| `prepare:remote-assets` | root `scripts/prepare-prebuilds.mjs` | invoked by orchestrator | `packages/desktop/mock-cdn/releases/<ver>/…` — remote (SSH/WSL) deploy bundle |
| `prepare:agent-bundle` | `scripts/prepare-agent-node-bundle.mjs` | invoked by orchestrator | `bundled-agents/<platformKey>/glm/zcode.cjs` (+ bundled-skills) |
| `prepare:native-search` | root `scripts/prepare-native-search-tools.mjs` | invoked by orchestrator | `bundled-tools/<platformKey>/{ripgrep,bfs,ugrep}` |
| `prepare:browser-import-helper` | `scripts/build-windows-browser-import-helper.mjs` | invoked only when `ZCODE_ENABLE_WINDOWS_BROWSER_IMPORT=1` + win32 | `bundled-tools/win32-<arch>/browser-import/zcode-browser-import-helper.exe` |
| `build:no-runtime-assets` | `prepare:build-meta` + `scripts/run-production-build.mjs` | — | `out/{main,host,preload,scheduler,renderer}` (tsup + vite, `run-production-build.mjs:46-65`) |
| `bundle` | `scripts/bundle.mjs` | — | runs `electron-builder -c electron-builder.config.js` with `--mac`/`--win`/`--linux` (`bundle.mjs:68-70,708-738`), mirrors + retries, then verifies asar runtime closure |
| `postinstall` | `scripts/node-pty-rebuild.mjs` | npm lifecycle | electron-rebuild `node-pty` for the host Electron ABI (skips on Windows when an N-API prebuild already exists, `node-pty-rebuild.mjs:100-113`) |

`prepare-runtime-assets.mjs:26-60` is the fan-out point and already exposes the two CI
knobs that matter for any port: `ZCODE_SKIP_REMOTE_ASSETS=1` (skip the remote mock-cdn
prep, used by the Windows install job to stay under the CI time cap) and the arch/os
override `ZCODE_TARGET_OS`/`ZCODE_TARGET_ARCH` (consumed by
`prepare-agent-node-bundle.mjs:68-70` and `build-windows-browser-import-helper.mjs:14`).
The `platformKey` is `<platform>-<arch>` (`prepare-agent-node-bundle.mjs:70`), i.e. the
existing cross-build hook is already parameterized on target os/arch.

---

## 1. Reuse-vs-replace map (per build step)

The key distinction for a Tauri cutover: **`prepare:*` asset producers are language-neutral
(Node/JS + prebuilt binaries) and are reused unchanged**; only the **`bundle`/packaging
step and the electron-builder `files`/`asar`/`extraResources` mechanics are replaced** by
Tauri's bundler + `externalBin`/`resources`.

| Current step | Verdict | Reasoning |
| ------------ | ------- | --------- |
| `prepare:agent-bundle` (`bundled-agents/<key>/glm/zcode.cjs`) | **REUSED, then re-staged** | The artifact is a shebang'd, `chmod 755`, self-contained CJS bundle (no NAPI; ripgrep is WASM) — `prepare-agent-node-bundle.mjs:1-12`, SIDECAR-PACKAGING.md §0. In Tauri it becomes the `zcode-agent` **externalBin**, copied to `src-tauri/binaries/zcode-agent-<TRIPLE>` (SIDECAR-PACKAGING.md §3). Same build command, different final placement + triple suffix. |
| `prepare:native-search` (`bundled-tools/<key>/{ripgrep,bfs,ugrep}`) | **REUSED unchanged** | Platform-specific prebuilt binaries extracted from repo archives with sha256 verify (`prepare-native-search-tools.mjs:40-85`). In Tauri they ship as `resources` under `tools/<tool>` (today's electron-builder `extraResources` `to: "tools/ripgrep"` etc., `electron-builder.config.js:622-634`). No change to how they are built — only how they are placed. |
| `prepare:browser-import-helper` | **REUSED unchanged** | Independent `.exe` built by Roslyn `csc.exe` on Windows only (`build-windows-browser-import-helper.mjs:34-88`); already gated off by default (`ZCODE_ENABLE_WINDOWS_BROWSER_IMPORT`). Ships as an extraResource regardless of runtime. |
| `prepare:remote-assets` / `prepare-prebuilds.mjs` (mock-cdn) | **REUSED unchanged — orthogonal** | Produces the **remote SSH/WSL deploy** bundle (`node`, `zcode-server.cjs`, `node-pty` prebuilds, `glm/zcode.cjs`, native-search tools + component manifests). This is not embedded into the desktop installer at all; the desktop build already runs it behind `ZCODE_SKIP_REMOTE_ASSETS`. Tauri does not change this — remote agents are Node-native and runtime-independent. |
| `out/{main,host,scheduler}` via `run-production-build.mjs` (tsup) | **SPLIT: renderer kept, main/host/scheduler re-targeted** | Renderer (`vite build` → `out/renderer`) is reused verbatim as Tauri `frontendDist` (`src-tauri/tauri.conf.json:10` → `../dist/renderer`). The Electron **main** process is replaced by the Rust shell (`src-tauri`, owned by another agent). The **host/scheduler** tsup outputs become sidecar launcher bundles — `SIDECAR-PACKAGING.md` §2(a)/§3 — because they keep `node-pty`/`ssh2`/`undici`/`yaml`/`node-forge`/`yauzl` as runtime `external` (SIDECAR-PACKAGING.md §0 asymmetry, `tsup.config.ts:110-122`). |
| `postinstall` `node-pty-rebuild.mjs` (electron-rebuild) | **REPLACED** | Tauri has no Electron ABI to rebuild against. `node-pty` is instead loaded by the Node **sidecar** (which ships its own Node runtime) or rebuilt for the sidecar's Node version. `@lydell/node-pty-{linux,darwin,win}-x64/arm64` prebuilds (`package.json:35-36`, `prepare-prebuilds.mjs:320-370`) become arch-specific sidecar `resources`. |
| `bundle.mjs` → electron-builder (`electron-builder.config.js`) | **REPLACED by `tauri build`** | Every electron-builder-specific mechanism (app.asar, `files`/`asarUnpack`, afterPack asar-rewrite/sourcemap-strip/native-policy asserts, NSIS `installSection.nsh` patch, `extraMetadata`, `publish` generic placeholder) is either dropped or re-implemented in Tauri terms (see §2/§3/§4). |
| `electronLanguages`, `electronDownload` mirror, `npmRebuild:false` | **N/A — dropped** | These are Electron-runtime-specific (`electron-builder.config.js:467-480,638`); Tauri links against the OS webview and has no Electron download. |

---

## 2. Per-OS Tauri build matrix (mapped from the electron-builder equivalents)

The electron-builder config is a **single-target-per-invocation** model
(`getTargetPlatform()` + `ZCODE_TARGET_OS/ARCH`), so it maps cleanly onto Tauri's
"one platform per runner" model (SIDECAR-PACKAGING.md §3 remaining ASSUMPTION: Tauri
cross-compiles one platform per job).

### 2.1 Linux — `electron-builder.config.js:685-719`

Current: `target: ["AppImage","deb","rpm","pacman"]`, `executableName`/`packageName` from
product identity (`desktop-product-identity.mjs:8-23`: `zcode`/`zcode-preview`), explicit
`pacman.depends` (`electron-builder.config.js:158-167`), `rpm.fpm` adding `mesa-libgbm` +
`alsa-lib` (711-718).

Tauri equivalent (`tauri.conf.json > bundle.linux`):
- Formats: `deb`, `rpm`, `appimage` (and optionally `pacman`-style is not a native Tauri
  target — **ASSUMPTION**: emit `.pkg.tar.zst` via a post-build `cargo`/`makepkg` step or
  drop pacman parity; Tauri v2 core targets are deb/rpm/AppImage).
- **Build deps** differ fundamentally: Electron *bundles* Chromium and declares runtime
  `gtk3/nss/libxss/libxtst/libnotify/alsa-lib/mesa` as package `depends`; Tauri does **not**
  ship a browser engine — it links the OS **WebKitGTK**. The install-time `depends` therefore
  change from Electron's set to the Tauri/WebKitGTK runtime closure.
  - Build-machine (compile) packages, **ASSUMPTION** (not in-repo; from Tauri v2 Linux docs):
    `libwebkit2gtk-4.1-dev`, `build-essential`, `curl`, `wget`, `file`, `libxdo-dev`,
    `libssl-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`.
  - Runtime (`deb`/`rpm`) depends: `libwebkit2gtk-4.1`, `libjavascriptcoregtk-4.1`,
    `libsoup-3.0` (or `-2.4` depending on webkit feature flag — **ASSUMPTION**), plus the
    GTK3/X11/ALSA/GBM libs the current config already had to pin. This is a genuine parity
    decision: Tauri trades "big bundled Chromium" for "system WebKit + versioned system
    libs you must declare per distro."
- The current `rpm.fpm` hard-won fix (`libgbm.so.1` missing on rockylinux:8,
  `electron-builder.config.js:714-718`) shows the class of bug to re-verify: confirm the
  Tauri AppImage/deb/rpm start on a minimal RHEL-8 + Arch container before shipping.

### 2.2 macOS — `electron-builder.config.js:648-680` + entitlements plists

Current model (grounded):
- Targets `["dmg","zip"]`; `category: public.app-category.developer-tools`.
- Two-stage pipeline: **build-phase signing + separate notarize job** —
  `notarize: false` explicitly disables the in-build notarize so it does not force
  `APPLE_APP_SPECIFIC_PASSWORD` before a DMG exists (`:661-665` comment).
- Signing gated on `ZCODE_ENABLE_MAC_SIGN=1` **and** a real identity from
  `APPLE_SIGNING_IDENTITY`/`CSC_NAME`, with `Developer ID Application:` prefix stripped for
  electron-builder 26.x (`:81-85,660-661`). Preview build with signing enabled but no
  identity **fails fast** (`:211-221`).
- `hardenedRuntime` on when signing; `entitlements: build/entitlements.mac.plist`
  (allow-jit, allow-unsigned-executable-memory, disable-library-validation,
  allow-dyld-environment-variables), `entitlementsInherit: build/entitlements.mac.inherit.plist`
  (same minus dyld-env), plus `build/entitlements.helper.plist` for nested helpers
  (allow-jit + unsigned-exec-memory only).
- `signIgnore` skips re-signing `Contents/Resources/glm` and `…/tools` because those are
  pre-signed in separate jobs (CUA Helper staple note, `:670-679`).

Tauri equivalent (`tauri.conf.json > bundle.mac` + `tauri build`):
- Targets: `dmg` + `app` (`.app.tar.gz` for the updater artifact — UPDATER-SPIKE.md §4).
- Tauri invokes `codesign` itself; you supply the signing identity and let Tauri apply
  hardened runtime + entitlements. The **entitlements must be ported forward**: the JIT +
  unsigned-executable-memory + disable-library-validation trio is required because the app
  runs a **Node sidecar** (JIT) and loads unsigned `.node` native addons — dropping any of
  them breaks the sidecar at Gatekeeper. `disable-library-validation` in particular is the
  one that lets the shipped `node` binary load the arch-specific `node-pty` `.node` files
  (SIDECAR-PACKAGING.md §3). Reuse `entitlements.mac.plist` / `.inherit.plist` as-is; add an
  entitlements file for the sidecar binaries if Tauri does not auto-inherit.
- **Sidecar signing**: SIDECAR-PACKAGING.md "Risks" §8 explicitly flags that sidecar
  external-executables must be signed/notarized with the app or Gatekeeper/AV kills them.
  In Tauri, `tauri build` signs the main bundle; nested `binaries/*-<TRIPLE>` and shipped
  `node` need to be deep-signed too — **ASSUMPTION**: rely on Tauri's codesign of bundle
  contents, but verify nested Mach-O signature validity with `codesign --verify --deep`
  (mirrors `scripts/doctor-macos-release-app.sh`, which exists in-tree).
- **Notarization**: keep the two-stage split. `tauri build` does **not** notarize by itself;
  run `xcrun altool`/`notarytool` in a dedicated macOS CI job against the produced `.dmg` /
  `.app.tar.gz`, then `stapler staple`. Credentials are the App Store Connect API trio
  (see §5 names). This matches the existing "build signs, a separate job notarizes" design.

### 2.3 Windows — `electron-builder.config.js:681-684,738-745`

Current: `target: ["nsis"]`, `nsis` config `oneClick:false`, `allowToChangeInstallationDirectory:true`,
custom installer/uninstaller/header icons; the `beforePack` hook patches
`app-builder-lib/templates/nsis/installSection.nsh` (`:504-533`,
`patch-nsis-install-section.mjs`); afterPack writes a `.zcode-install-manifest`
(`:171-191`).

Tauri equivalent (`tauri.conf.json > bundle.windows`):
- Formats: `nsis` (default) and/or `msi`. UPDATER-SPIKE.md §4/§7 already flags the parity
  question of whether `createUpdaterArtifacts` NSIS can reproduce the patched
  `installSection.nsh` — **ASSUMPTION: needs a Windows build to confirm**; Tauri's NSIS
  template supports custom `installerHooks`, which is the likely replacement for the
  install-section patch.
- **Code signing**: Tauri uses the Windows signing via `tauri.conf.json`
  (`bundle.windows.certificateThumbprint` / `certificateFile` + password) or a pre/post
  signing step with `signtool`. Map from electron-builder's implicit `CSC_*`/`WIN_CSC_*`
  model (none present in-repo → **ASSUMPTION**: the org's Windows signing cert + password
  are CI secrets). Sign the main `.exe`, the NSIS/MSI installer, AND the sidecar
  `binaries/*-x86_64-pc-windows-msvc.exe` + shipped `node.exe` (SIDECAR-PACKAGING.md
  Windows risk note). Unsigned sidecars get killed by AV.
- **`glm`/`tools` layout must survive**: UPDATER-SPIKE.md §1a/§4 confirms the Windows
  install-lock problem (NSIS overwriting `process.resourcesPath/glm|tools` while host/agent
  hold handles) is runtime-independent. In Tauri those dirs move to `resources` / sidecar
  `NODE_PATH` siblings; the release/CI job must keep the same "release handles before
  overwrite" guarantee (implemented in the Node sidecar, not CI — cross-ref UPDATER-SPIKE §5).

### 2.4 Product identity / flavor parity across runtimes

`desktop-product-identity.mjs` (appId `dev.zcode.app` / `dev.zcode.app.preview`,
productName `ZCode`/`ZCode Preview`, `_TEST` artifact suffix, Linux pkg/exec names) is
pure Node logic and is **REUSED unchanged** to feed `tauri.conf.json` `productName` /
`identifier` at CI time (today's `src-tauri/tauri.conf.json:3-5` is a dev placeholder:
`ZCode (Tauri dev)` / `app.zcode.desktop.tauri.dev` / version `0.0.0`). Keep Production and
Preview as **separate bundles with separate identifiers** — same rule the electron-builder
config enforces (`:696-719`).

---

## 3. Sidecar build step (host / agent / scheduler externalBin)

Grounded in SIDECAR-PACKAGING.md §1-§3; CI specifics only, no duplication of the naming rule.

1. Build the JS artifacts with the **existing** commands (unchanged):
   - Agent: `node scripts/build-desktop-agent-cli.mjs` (= `prepare:agent-bundle`) →
     `bundled-agents/<platformKey>/glm/zcode.cjs`.
   - Host/Scheduler: `pnpm --dir packages/desktop build:no-runtime-assets` (tsup) →
     `out/host/index.js`, `out/scheduler/index.js`, then an **esbuild launcher pass**
     keeping `node-pty`/`ssh2`/`undici`/`yaml`/`node-forge`/`yauzl` external
     (SIDECAR-PACKAGING.md §2(a)/§3).
2. A new CI build step (`prepare:tauri-sidecars.mjs`, mirrors
   `prepare-agent-node-bundle.mjs`) copies/renames/chmod to the target-triple path and the
   `.exe` suffix on Windows (SIDECAR-PACKAGING.md §3):
   `cp out/host/index.js → src-tauri/binaries/zcode-host-<TRIPLE>` + `chmod 755`;
   `cp bundled-agents/<key>/glm/zcode.cjs → src-tauri/binaries/zcode-agent-<TRIPLE>`.
3. Node runtime: ship a `node` binary per platform as a `resources` sibling (Agent targets
   `node22`; remote already standardizes on Node **v22.16.0**,
   `prepare-prebuilds.mjs:51`) and set `NODE_PATH` to the host-externals dir at spawn
   (SIDECAR-PACKAGING.md §2 Node-runtime option 1, §4 env).

**Arch × target matrix** (Rust triples from SIDECAR-PACKAGING.md §3, x86_64/aarch64 only —
mirrors the current `@lydell/node-pty-{linux,darwin}-x64/arm64` split, `package.json:35-36`):

| os | arch | Rust triple (`<TRIPLE>`) | sidecar file suffix | native `node-pty` package |
| -- | ---- | ------------------------ | ------------------- | ------------------------- |
| linux | x86_64 | `x86_64-unknown-linux-gnu` | `…-x86_64-unknown-linux-gnu` | `@lydell/node-pty-linux-x64` |
| linux | aarch64 | `aarch64-unknown-linux-gnu` | `…-aarch64-unknown-linux-gnu` | `@lydell/node-pty-linux-arm64` |
| darwin | x86_64 | `x86_64-apple-darwin` | `…-x86_64-apple-darwin` | darwin-x64 prebuild + `spawn-helper` |
| darwin | aarch64 | `aarch64-apple-darwin` | `…-aarch64-apple-darwin` | darwin-arm64 prebuild + `spawn-helper` |
| win32 | x86_64 | `x86_64-pc-windows-msvc` | `…-x86_64-pc-windows-msvc.exe` | win-x64 prebuild (+ winpty) |
| win32 | aarch64 | `aarch64-pc-windows-msvc` | `…-aarch64-pc-windows-msvc.exe` | win-arm64 prebuild |

- `ZCODE_TARGET_OS`/`ZCODE_TARGET_ARCH` (already the cross-build hook) must be mapped to the
  Rust triple table in `prepare:tauri-sidecars.mjs` (SIDECAR-PACKAGING.md §3 cross-build note).
- **JS is platform-independent, native externals are not**: `zcode.cjs` is one file across
  platforms (`prepare-agent-node-bundle.mjs:9`), so per-arch CI only needs to *rename* it and
  re-stage the arch-specific `node-pty` `.node` prebuild + matching `node` binary.
- **ASSUMPTION** (SIDECAR-PACKAGING.md §3 remaining): producing all triples needs per-arch CI
  jobs; validate by running `tauri build` once with a trivial sidecar and reading the emitted
  bundle layout / externalBin validation error before scaling.

---

## 4. Updater signing (minisign) — key handling & manifest publication

Grounded in UPDATER-SPIKE.md §2/§4/§5; this section adds only the CI custody rules.

- **Keypair generation off-machine**: `cargo tauri signer generate` must run OUTSIDE CI and
  OUTSIDE the repo. Never in a job that emits logs.
- **Public key → committed**: the base64 public key goes in `src-tauri/tauri.conf.json` →
  `plugins.updater.pubkey` (UPDATER-SPIKE.md §4: "safe to commit; it is public"). This is the
  ONLY updater secret that lands in the tree.
- **Private key + password → CI secrets only** (names in §5): `tauri build` reads
  `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` from the environment to
  emit `<artifact>.sig` for each bundle with `bundle.createUpdaterArtifacts: true`
  (UPDATER-SPIKE.md §2). Never echo, print, commit, or write these to a file artifact.
- **Signed static manifest publication**: UPDATER-SPIKE.md §4 recommends co-locating a
  Tauri-format JSON manifest on the existing release service (generated from the same release
  records that produce today's Electron YAML), served at
  `GET {origin}/api/v1/releases/tauri/{{target}}-{{arch}}/{{current_version}}`, with per-OS
  entries carrying `signature` (minisign `.sig`) + `url` (`.exe`/`.msi`, `.app.tar.gz`,
  `AppImage`/`.deb`/`.rpm`) — see UPDATER-SPIKE.md §2 platform-key shape (keys are
  **ASSUMPTION**, verify against pinned Tauri version). Today's electron-builder `publish`
  is a placeholder (`http://localhost:8081`, `electron-builder.config.js:747-756`); the real
  CDN/manifest endpoint is external (**ASSUMPTION**, UPDATER-SPIKE.md §7).
- **Recommendation cross-ref**: UPDATER-SPIKE.md §5 says do **not** switch to
  `tauri-plugin-updater` for the first cutover; the minisign pipeline above is a P6/phase-2
  prerequisite, not a day-1 blocker. CI should stage the keypair/pubkey but the fallback
  (manual download deep-link) ships first.

---

## 5. Secrets inventory (NAMES only — never values)

Read from the signing/notarize/update code paths above. The Electron pipeline already uses
the first five; the Tauri port adds the minisign + updater-endpoint names.

| Name | Used by | Purpose | Notes |
| ---- | ------- | ------- | ----- |
| `APPLE_SIGNING_IDENTITY` (alt `CSC_NAME`) | `electron-builder.config.js:81`, Tauri mac build | Developer ID Application code-signing identity string | Already in use; `ZCODE_ENABLE_MAC_SIGN=1` toggles signing. |
| `ZCODE_ENABLE_MAC_SIGN` | `electron-builder.config.js:84-85,211-221` | Build flag enabling macOS hardened-runtime signing | Env switch, not a secret value; listed for completeness. |
| `APPLE_ID` | macOS notarize job (`notarytool`) | Apple ID for notarization | **ASSUMPTION**: name per Apple's `notarytool` convention (not in-tree). |
| `APPLE_APP_SPECIFIC_PASSWORD` | macOS notarize job | App-specific password for `notarytool` | UPDATER-SPIKE/autoUpdater comment (`electron-builder.config.js:663`) confirms this is required only at the *notarize* phase, not build. |
| `APPLE_TEAM_ID` | macOS notarize + staple | Developer team ID | **ASSUMPTION** name. |
| macOS keychain / `.p12` cert + password | Developer ID cert install on mac runner | Provides the signing identity | electron-builder uses `CSC_LINK`/`CSC_KEY_PASSWORD`; **ASSUMPTION** exact names (not in-tree). |
| Windows code-signing cert + password (`CSC_LINK`/`CSC_KEY_PASSWORD`, or `WIN_CSC_*`) | Windows sign (signtool/Tauri windows config) | Authenticode signing of `.exe`/installer/sidecars | Not referenced in-repo → **ASSUMPTION**: org holds a code-signing cert; Tauri uses `bundle.windows.certificateFile`/`certificateThumbprint`. |
| `TAURI_SIGNING_PRIVATE_KEY` | `tauri build` (updater `.sig`) | minisign **private** key for updater artifact signing | UPDATER-SPIKE.md §2/§4. NEVER commit/print. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | `tauri build` | passphrase protecting the minisign private key | UPDATER-SPIKE.md §2. NEVER commit/print. |
| Updater endpoint / manifest base URL (and any CDN auth token) | release publish + `plugins.updater.endpoints` | Where the signed JSON manifest + artifacts are hosted | External service config (UPDATER-SPIKE.md §7); if token-authed, its value is a secret, name only here. |
| `ZCODE_NODE_DIST_MIRROR` / intranet deps base | `prepare-prebuilds.mjs:72-75,509-516`, `bundle.mjs:165` | Download mirror URLs (not credentials, but CI config) | May embed an internal host; keep out of logs per AGENTS.md 日志边界. |

Per AGENTS.md Security: none of the above values may appear in code, logs, or committed
`tauri.conf.json`; only the **public** updater key is committed. `.env` (gitignored) or the
CI secret store only.

---

## 6. Phase-1 harness CI job (os × runtime matrix)

Grounded in `TEST-HARNESS.md` §4 and the real layer-A tests now on disk
(`packages/desktop/tauri-port/test/layer-a/{a1-ws-rpc,a2-framing,a3-stdio-roundtrip}.test.ts`
+ `_host.ts`) plus root scripts (`package.json`: `typecheck` = `tsc -b …`, `lint` = `oxlint`,
`architecture:check`).

Matrix (TEST-HARNESS.md §4.3): `os: [ubuntu-latest, macos-latest, windows-latest] ×
runtime: [electron, tauri]`. Phase-1 job runs the GUI-free tiers only (Layer A + Layer B P0);
Layer C is SKIPPED with a reason until a Tauri webview driver exists (§4.3, §8).

```
jobs:
  verify:
    parallel:
      - pnpm typecheck                 # root: tsc -b across all packages (incl. tsconfig.host.json)
      - pnpm architecture:check --changed
      - per-package lint               # oxlint; each package's `lint` script (e.g. packages/desktop "lint": "oxlint")
    rust:
      # src-tauri owned by another agent — harness only CONSUMES cargo test output (TEST-HARNESS §4.1)
      - cargo check && cargo test && cargo clippy -- -D warnings && cargo fmt --check   # cwd packages/desktop/src-tauri
    layer-a:
      - npx tsx --test packages/desktop/tauri-port/test/layer-a   # A1/A2/A3, headless, both fixtures
    packaging (release-only, not this gate):
      - matrix os × arch: tauri build for host/agent/scheduler sidecars (§3) + sign/notarize (§2)
  parity (future gate, TEST-HARNESS §4.4):
    - pnpm test:parity     # diff Electron vs Tauri TAP/JUnit; enforce equal-pass-count + zero-new-skips + Layer-B member-set equality
```

Rules for the CI job, from the harness doc:
- The pass-count gate blocks the parity claim if the Tauri target has fewer passes or a new
  skip without a phase-deferral reason (TEST-HARNESS.md §4.4, AGENTS.md Phase 1).
- Layer A must not branch on `electron`/`tauri` in assertions — only the fixture factory does
  (§3 Layer A, §5.2). A3 promotes the WS PoC to `node:test` and asserts **byte-level**
  equality on binary round-trips (§6).
- `cargo test` and the `tsc` check on `tauriBridge.ts`/`tauriPlatform.ts` are prerequisites
  the harness consumes, not re-runs it (§4.1).
- Headless launch: Linux runs under `xvfb-run` when any job needs a display (§4.2); Layer A/B
  need none.

---

## 7. Effort, risk, and open questions

**Effort (rough, port-scoped):**
- Reuse of `prepare:*` asset producers is near-free (unchanged scripts; just re-stage outputs
  into `externalBin`/`resources`). The genuinely new work is: `prepare:tauri-sidecars.mjs`
  (copy/rename/chmod + esbuild launcher, SIDECAR-PACKAGING.md §5 step 5), the
  entitlements-forward + deep-sign of sidecars on macOS, the Linux WebKitGTK depends
  re-derivation per distro, and the minisign release pipeline (§4).

**Risks (ranked):**
1. **macOS sidecar Gatekeeper** (HIGH): shipping an unsigned/un-stapled `node` +
   `*-<TRIPLE>` Mach-O sidecars gets them killed at launch. Mitigation: keep
   `disable-library-validation` + `allow-unsigned-executable-memory`
   (`entitlements.mac.plist`), deep-sign and notarize the whole bundle including nested
   binaries; verify with `codesign --verify --deep` / `doctor-macos-release-app.sh`.
2. **Linux runtime-lib drift** (HIGH): Tauri swaps bundled Chromium for system WebKitGTK;
   the current config's hard-won rpm/pacman `libgbm`/`alsa` pins (`:714-718`) show this is
   where packages silently fail at first launch. Re-verify on minimal RHEL-8 + Arch images.
3. **Windows updater/NSIS install-lock parity** (HIGH): UPDATER-SPIKE.md §3/§7 — whether
   `createUpdaterArtifacts` NSIS reproduces the patched `installSection.nsh` and whether the
   `glm/tools` overwrite-lock is preserved when those move to Tauri `resources`.
4. **Cross-arch sidecar matrix complexity** (MED): six triples × native `node-pty` + shipped
   `node` per platform; SIDECAR-PACKAGING.md §3 flags this needs per-arch jobs.
5. **CI runtime cap** (MED): today's Windows job already uses `ZCODE_SKIP_REMOTE_ASSETS=1` to
   stay under the ~1h cap (`prepare-runtime-assets.mjs:52-55`); Tauri adds a Rust compile +
   sidecar stage that must fit the same budget or split jobs.

**Open questions for the org:**
- Does the org hold an **Apple Developer ID** (notarization-capable) account usable for the
  Tauri `.dmg`/`.app.tar.gz` targets, or is it only the Electron cert today? (§5 names.)
- Is a **Windows code-signing cert** available to sign Tauri NSIS/MSI + sidecar `.exe`, or is
  Electron's implicit `CSC_*` the only signing path currently provisioned?
- Will the release service publish a **Tauri-format JSON manifest** co-located with the
  existing Electron YAML (UPDATER-SPIKE.md §4), and can it generate both from one release
  record to keep a single source of truth?
- Is `pacman` packaging parity required, or acceptable to drop (no native Tauri target —
  §2.1 ASSUMPTION)?
- Which exact `libsoup`/`webkit2gtk` feature-flag set is pinned for the Linux build/deploy
  matrix (§2.1 ASSUMPTION)?
