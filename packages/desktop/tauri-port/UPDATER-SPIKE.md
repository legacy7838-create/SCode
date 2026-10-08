# UPDATER-SPIKE — Electron `electron-updater` → `tauri-plugin-updater`

READ-ONLY spike. No source, config, or `src-tauri` file was modified. All claims are cited to
repo files; anything not verifiable in-repo is marked **ASSUMPTION**.

Scope (INVENTORY §2 line 55, §HIGH list line 71-72, `PLATFORM-ADAPTER-PLAN.md` §1g lines
110-127, P6 line 372): `electron-updater` is a HIGH port-blocker because Tauri's updater uses a
different signing model (minisign, not sha512/differential), a different install/format model, and
the app layers a **custom force-update gate** and a **Windows NSIS resource-lock cleanup** on top.
This document grounds a migration decision.

---

## 1. Current flow (as implemented)

Files: `src/main/autoUpdater.ts` (state machine, ~1944 lines), `src/main/manifestUpdateProvider.ts`
(feed), `src/main/forceUpdateGuard.ts` + `forceUpdatePrompt.ts` (startup gate),
`src/main/windowsInstallResourceLocks.ts` + `src/main/index.ts:949-1001` (install-lock cleanup).

```
                        ┌───────────────────────────────────────────────┐
 startup (index.ts)     │ maybeBlockStartupForForceUpdate (BEFORE window)│
                        │  GET /api/v1/client/configs?app_version&platform│
                        │  code!=0 → throw → offline: return null, NO block│
                        │  resolveForceUpdateRequirement(minimalVersion)  │
                        │  blocked? → showForceUpdatePrompt (modal)       │
                        │    auto  → requestForceAutoUpdate → (flow below) │
                        │    manual → shell.openExternal(origin/{cn,en})   │
                        │    quit   → app.quit()                            │
                        └───────────────────────────────────────────────┘
                                        │ not blocked
                                        ▼
 initAutoUpdater (autoUpdater.ts:1481)  〔prod flavor only: enabled = ZCODE_PRODUCT_FLAVOR==="production"〕
   autoDownload=false; autoInstallOnAppQuit = (platform!=="win32"); logger
   setFeedURL({provider:"custom", updateProvider:ManifestUpdateProvider, ...})
   ├─ triggerCheckForUpdates("startup")            〔startup〕
   └─ setInterval(triggerCheckForUpdates("poll"), 1h)  AUTO_UPDATE_POLL_INTERVAL_MS (line 45)

 CHECK (ManifestUpdateProvider.getLatestVersion, manifestUpdateProvider.ts:205)
   GET {endpointOrigin}/api/v1/releases/electron/manifest
       ?platform=<win|darwin|linux>-<x86_64|aarch64|x86>   getElectronReleasePlatform()
       &device_mid=<mid>            ← options.deviceMid
       &channel=1|3                 ← stable|preview (settings.receivePreviewUpdates)
   headers: X-Platform, X-Release-Channel, X-Device-Mid, Accept: application/x-yaml,text/yaml,...
   response = YAML (parseYaml); requires { version: string, files[]|path, sha512|sha2 }
   resolveFiles()  → per-OS updater filter (AppImage/Deb/Rpm/Pacman); fails closed on
                     missing/foreign checksum (line 147-152). NO differential: isUseMultipleRangeRequest=false.

 STATE MACHINE (menuState: AutoUpdaterMenuState)  idle|checking|update-available|download-progress|update-downloaded
   update-available:  semver compare (isVersionGreaterThan) vs readyUpdateVersion;
                      skip persisted skippedElectronUpdateVersions[channel] (isSkippedUpdateVersion)
                      → buildUpdateAvailableState  → broadcast UpdateStateChanged
                      → if autoDownloadAndInstall pref → downloadAvailableUpdate (line 1621)
   download-progress: gated on active CancellationToken (line 1668) → buildDownloadProgressState
                      percent + transferredBytes/totalBytes
   update-downloaded: readyUpdateVersion; persist pendingPostUpdateReleaseNotes (settings) for
                      restart-restore; sync UpdateReady to every window; if force listener → quitAndInstall
   error:             handleAutoUpdateFailure; on macOS Squirrel post-ready staging error clears ready;
                      download-fail returns to update-available (NOT idle) so user can retry (line 1051)

 DOWNLOAD: autoUpdater.downloadUpdate(CancellationToken)  — cancellable (token.cancel, cancelled-token WeakSet
           dedups the delayed error("cancelled") event, line 981-1004)

 INSTALL — quitAndInstallUpdate (autoUpdater.ts:414):
   guard state==="update-downloaded" && readyUpdateVersion (else throw when rejectUnavailable; IPC uses it)
   quitAndInstallInFlight re-entry guard
   await onBeforeQuitAndInstall()  ← index.ts:1693
        prepareAppQuit(...)                 // host/agent tree reclaim (7.5s SIGKILL / 9s barrier)
        if win32: prepareWindowsProcessesForUpdateInstall()  // see §1a
   dev fallback (not packaged): app.relaunch(); app.exit(0)   (line 476-484)
   else: autoUpdater.quitAndInstall()      // native electron-updater installer handoff
   IPC (PlatformChannels): QuitAndInstallUpdate (handle+on), DownloadUpdate, CancelUpdateDownload,
       SkipUpdateVersion, UpdateStateChanged, UpdateReady, UpdateCheckResult, PostUpdateReleaseNotes
```

Renderer observes/controls updates purely through `IPlatformService` update rows
(`PLATFORM-ADAPTER-PLAN.md` §1g:114-126): `onUpdateReady/onUpdateCheckResult/onUpdateStateChanged`,
`getUpdateState`, `downloadUpdate`, `cancelUpdateDownload`, `skipUpdateVersion`,
`get+setAutoUpdatePreferences`, `onPostUpdateReleaseNotes`/`acknowledgePostUpdateReleaseNotes`,
`quitAndInstallUpdate`, `openUpdateStatusWindow`. There is a **replay-cache** requirement
(INVENTORY §2:121, PLAN §:261-263): `UpdateReady` may fire before the renderer subscribes on cold
start, so main re-sends it via `syncReadyUpdateToWindow` (autoUpdater.ts:1353) and persists
`pendingPostUpdateReleaseNotes` for restart-restore (`hydratePendingPostUpdateReleaseNotes`:1309).

### 1a. Windows install-lock cleanup + `taskkill` self-kill (`windowsInstallResourceLocks.ts`, `index.ts:878-1001`)

- Bundled resource dirs `["glm","tools"]` under `process.resourcesPath` are what NSIS overwrites
  on update. If any host/agent process still holds a handle, NSIS leaves a **half-update**
  (app launches but bundled agent missing). This is the root problem the cleanup solves.
- `findWindowsProcessesReferencingResourceMarkers` runs **PowerShell**
  `Get-CimInstance Win32_Process` (3s timeout, 2MB buffer), lower-cases+`\`-normalizes each
  `CommandLine + ExecutablePath`, keeps only PIDs whose cmdline references the resource dirs, and
  **skips `$PID` (its own process)** (script line 234-236).
- `forceTerminateWindowsAgentProcesses` → `taskkill /PID <pid> /T /F` per tree (execWithTimeout,
  `windowsHide`), then a **750 ms** `WINDOWS_UPDATE_LOCK_RELEASE_GRACE_MS` handoff, then a rescan +
  a writable probe (sentinel write/rename in `glm`/`tools`) for diagnostics.
- PIDs are re-scanned at cleanup time (never reuse exit-barrier PIDs) because Windows reuses PIDs
  (comment lines 46-51).
- Separate **E2E-only self-kill** (index.ts:804-816): under `ZCODE_E2E_RUN_ID`, `exitPreparedApp`
  spawns detached `taskkill /PID <own pid> /F` (non-Windows: `kill -9`). This is NOT the updater
  path — flagged so a porter does not conflate the two `taskkill` uses.

### 1b. Feed / build config today

- `electron-builder.config.js:747-756` `publish: { provider: "generic", url: "http://localhost:8081",
  useMultipleRangeRequest: false }` — a **placeholder**; runtime uses `ManifestUpdateProvider`
  against the service endpoint, not this static feed (comment lines 753-754).
- `dev-app-update.yml` (generic, `http://localhost:8081`, `updaterCacheDirName: zcode-dev-updater`)
  is a dev-config placeholder read only when `ZCODE_AUTO_UPDATE_DEV` is on.
- Feed override `--zcode-update-feed-url` / `ZCODE_UPDATE_FEED_URL` honored **only when not packaged**
  (`resolveUpdateFeedSourceFromStartupConfig`:714-734; fail-closed otherwise). `resolveEndpointOrigin`
  is dynamic (`resolveRuntimeZCodeEndpointOrigin`).
- Windows NSIS is patched at build time: `electron-builder.config.js` `beforePack` mutates
  `app-builder-lib/templates/nsis/installSection.nsh` (`patch-nsis-install-section.mjs`) and
  `build/installer.nsh` custom macros. Real feed/artifact URLs are **not** in-repo (**ASSUMPTION**:
  the live manifest endpoint + CDN are external service config, not committed).

---

## 2. `tauri-plugin-updater` model (grounded to Tauri v2 docs; **ASSUMPTION** on exact API surface)

- **Signing**: minisign over Ed25519 (SIG/legacy minisign key), NOT sha512/differential. Keys
  generated with `cargo tauri signer generate` → write a `.key` (private) + get a base64 **public
  key**. Artifacts signed at build time; `bundle.createUpdaterArtifacts: true` produces
  `<artifact>.sig`. Private key supplied in CI via `TAURI_SIGNING_PRIVATE_KEY` (+
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) secrets — never committed.
- **Manifest endpoint**: a JSON file (default `latest.json`, or per-platform) referenced by
  `plugins.updater.endpoints: [ "<base>/{{target}}-{{arch}}/{{current_version}}" ]` template, and
  `plugins.updater.pubkey: "dW50cnVzdGVkIGNvbW1lbnQ6..."` (the base64 public key) must match.
  Manifest shape:
  ```json
  { "version": "3.4.1",
    "notes": "…release text…",
    "pub_date": "2026-…Z",
    "platforms": {
      "windows-x86_64": { "signature": "<minisign .sig>", "url": "…exe|msi" },
      "darwin-aarch64": { "signature": "…", "url": "…app.tar.gz" },
      "linux-x86_64":   { "signature": "…", "url": "…AppImage|deb|rpm" } } }
  ```
  (platform keys: `windows-x86_64/i686/aarch64`, `darwin-x86_64/aarch64`,
  `linux-x86_64/aarch64/armv7`; **ASSUMPTION**: verify against pinned Tauri version.)
- **Installers it drives**: Windows `.exe` (NSIS) or `.msi`; macOS `.app` (from `.app.tar.gz`);
  Linux `AppImage`, `.deb`, `.rpm`. Verification: download → check minisign signature against the
  configured pubkey → run the native installer/updater.
- **API/semantics**: `let update = updater.check().await?` (returns `Update` with
  `version/notes/date`); `update.download_and_install(on_progress_fn, on_event_fn)` streams
  `Progress`/`Status` events; `update.download()` then `update.install()`. On install the plugin
  **re-execs the app / hands off to the platform installer and relaunches** — on macOS App
  in-place swap + relaunch, on Windows it launches the NSIS/MSI which requires the app to quit. The
  process must be allowed to exit for install (no `autoDownload=false` toggle; download is explicit
  by calling `download`).

---

## 3. Gap analysis (capability → Tauri equivalent / missing)

| Current capability (autoUpdater.ts / guard / locks) | `tauri-plugin-updater` equivalent | Gap / port action |
| --- | --- | --- |
| `checkForUpdates` → `update-available/not-available` | `check()` → `Option<Update>` | Direct. Semver vs current handled by plugin. |
| Custom **service YAML manifest** provider, `device_mid`, `channel` header/query, dynamic `endpointOrigin` | Static **JSON** manifest + `{{target}}/{{arch}}/{{current_version}}` templating | **MISSING**: Tauri won't hit a bespoke YAML API or send `X-Device-Mid`/`X-Release-Channel`. Need a server endpoint returning Tauri JSON schema, or a thin Rust proxy command. |
| sha512/`sha2` checksum verification, differential (`useMultipleRangeRequest=false`) | **minisign** Ed25519 signature | **MODEL CHANGE**: re-sign every artifact; drop differential download (Tauri does full-artifact download; **ASSUMPTION** no diff updates in stable v2). |
| `autoDownload=false` (explicit download gate) | download only fires when you call `download`/`download_and_install` | Equivalent by design: don't auto-call install. |
| `autoInstallOnAppQuit = (platform!=="win32")` | no quit-time auto-install concept; install is explicit | Behavior preserved by not calling install on quit. |
| Cancellable download (`CancellationToken`, delayed-cancel dedup) | `check`/`download` are `.await`; no built-in cancel token | **MISSING**: implement cancel via Rust `JoinSet`/abort of the download task; surface cancel command to renderer. |
| `download-progress` percent + transferredBytes/totalBytes | `Progress`/`Status` events (`with_registration`, `download_and_install` cb) | Present but different fields; map to `UpdateStatePayload`. |
| **release notes** localized (zh-CN/en-US) + markdown + post-update "What's new" persistence (`pendingPostUpdateReleaseNotes`, ack flow, restart-restore) | manifest `notes: string` (single, optional `#[serde]`) | **MISSING**: no multi-locale, no persisted post-update-ack / stale-version discard. Rebuild in Rust + settings store; keep `PostUpdateReleaseNotes` command/event. |
| **skip this version** (`skippedElectronUpdateVersions[channel]`) | none | **MISSING**: app-side persistence + compare on `check`. |
| **preview/stable channel** toggle | none (single endpoint list) | **MISSING**: point endpoints per-channel, or filter result in Rust. |
| Menu-item label sync (check-for-update label/state) | no native menu integration in plugin | Re-implement via `muda`/`tauri` menu + state broadcast. |
| **Force-update startup gate** (`/client/configs` minimalVersion → modal, blocks main window) | none — plugin is check/download/install only | **MISSING entirely**: keep the gate as a Rust command + a `WebviewWindow` prompt (`forceUpdatePrompt.ts` inline HTML must be re-hosted). `requestForceAutoUpdate` auto-install loop must be re-driven. |
| **Prompt window** (frameless modal, inline HTML/CSS, height reflow, close-confirm state machine) | Tauri `WebviewWindow` can host the same HTML | Port as a new `WebviewWindow` (see PLAN `openUpdateStatusWindow` MED). `executeJavaScript`/`page-title-updated` IPC tricks must map to Tauri events/commands. |
| **Windows install-lock cleanup** (`taskkill` trees referencing `glm/tools`, 750ms grace, writable probe) | none — Tauri NSIS/MSI has no equivalent resource-lock release | **MISSING / HIGH**: this is the same class of problem and Tauri does NOT solve it. Re-implement in Rust (`std::process` + WMI/`taskkill`) or keep in the Node **sidecar** (INVENTORY: host/agent processes live in the sidecar anyway, so the sidecar can release handles before install). |
| `quitAndInstall` guarded re-entry + macOS `before-quit` close-window workaround | `download_and_install` relaunch semantics; must exit for install | Port carefully: guard install-in-flight; Tauri's relaunch differs from Electron's `app.relaunch`. |
| Dev-only relaunch fallback / `ZCODE_AUTO_UPDATE_DEV` version override | n/a in Tauri; `check()` uses `tauri.conf.json` version | Re-implement dev override if needed (low priority). |

Biggest true gaps: **bespoke feed endpoint**, **minisign re-keying of the whole release pipeline**,
**force-update gate + prompt window**, **Windows install-lock cleanup**, and the **release-notes /
skip / cancel / channel** app-level state. None of the plugin's primitives cover them; they must be
built as Rust commands + a new server-side Tauri-format manifest.

---

## 4. Feed / endpoint migration + key management

- **Co-locate a new Tauri-format JSON manifest** on the existing service so both clients work during
  migration. Today's runtime feed is
  `GET {origin}/api/v1/releases/electron/manifest?platform&channel&device_mid` (YAML).
  Add e.g. `GET {origin}/api/v1/releases/tauri/{{target}}-{{arch}}/{{current_version}}` (JSON,
  Tauri schema) and point `plugins.updater.endpoints` at it. The service can generate the JSON
  manifest from the same release records that produce the Electron YAML, so the release source of
  truth stays single.
- **Signing keys**: run `cargo tauri signer generate -w <path>` OFF-machine. Put the **base64 public
  key** in `src-tauri/tauri.conf.json` → `plugins.updater.pubkey` (this value is safe to commit;
  it is public). Put the **private key** + its password in **CI secrets**
  (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) used by `tauri build` to emit
  `.sig` for each artifact (`bundle.createUpdaterArtifacts: true`). Do NOT print, commit, or echo
  the private key or its password. Existing repo secrets handling (AGENTS.md Security) requires
  `.env`/CI-only for anything sensitive — the pubkey is the only updater secret that lands in the
  tree.
- **Artifact parity**: Windows `nsis`/`msi` + `.sig`, macOS `.app.tar.gz` + `.sig`, Linux
  `AppImage`/`deb`/`rpm` + `.sig`. Note the Electron pipeline patches NSIS
  (`patch-nsis-install-section.mjs`) — verify whether the equivalent NSIS customization is needed in
  the Tauri Windows installer; the `glm/tools` **resource layout** (bundled agent) still must exist
  in the Tauri package for the sidecar (SIDECAR-PACKAGING.md), so the install-lock problem persists
  regardless of updater choice.

---

## 5. Recommendation

**Do NOT switch to `tauri-plugin-updater` for the first cutover.** Ship the Tauri port with a
**behavior-preserving updater shim in the Node sidecar / a Rust command that keeps `electron-updater`
out of the runtime** is impossible (electron-updater needs Electron), so the realistic options are:

1. **Recommended: keep the Electron-style control plane, adopt `tauri-plugin-updater` ONLY as the
   download/install engine, behind the existing `IPlatformService` update surface.**
   - Rust `#[tauri::command]` set mirrors §1g rows: `check_update`, `download_update`,
     `cancel_update_download`, `quit_and_install`, `get_update_state`, release-notes ack — each
     emitting the same `UpdateStatePayload`/`UpdateCheckResultPayload` events so the renderer and
     the **force-update gate are unchanged**.
   - `download_and_install` progress → mapped to `download-progress`; explicit download = don't
     auto-install; cancel = abort the download task.
   - Force gate (`/client/configs` minimalVersion) + prompt `WebviewWindow` stay app-side, calling
     the same commands.
   - Windows install-lock cleanup **stays in the Node sidecar** (it already owns `glm/tools`
     processes; it can `taskkill` its own agent trees before install) — do not reimplement in Rust.
   - **Prereq/blocker**: release infra must re-sign every artifact with minisign + serve the Tauri
     JSON manifest. This is the real cost, not the code.
   - **Effort**: L (feed/key pipeline 2-3 days; Rust commands + event mapping 3-4 days; prompt
     `WebviewWindow` 1-2 days; force-gate re-drive 1-2 days; Windows lock/sidecar integration 2 days;
     E2E across 3 OS).
   - **Risk**: HIGH (signing pipeline, install-lock parity, macOS/Windows relaunch semantics,
     cancelled-download races, replay-cache parity for `UpdateReady`).

2. **Fallback (lowest risk): keep the "download update" deep-link + manual install only.**
   - Drop in-app auto-download/auto-install. `check_update` reads the manifest; on
     `update-available` the renderer shows the existing UpdateAvailable UI whose primary action is
     `shell.openExternal(origin/{cn,en})` (already the force-gate "manual" path,
     `forceUpdateGuard.ts:184-190,245-249`). The **force-update gate stays fully functional**
     (it is a version compare + modal + open-external, independent of `electron-updater`).
   - Pro: no minisign pipeline, no install-lock parity, no relaunch semantics; ships day 1.
   - Con: loses one-click auto-update UX and differential download; users download the installer
     from the browser.

3. **Hybrid**: ship fallback (option 2) at cutover, add `tauri-plugin-updater` (option 1) in a
   later phase once the signing/manifest pipeline is ready. Matches PLAN's staging (updates = P6,
   "installer/lock semantics spike").

---

## 6. 1-day PoC (no install)

Goal: prove the Tauri updater can parse a **static signed manifest** and report
"update available / up to date", without downloading or installing.

1. Fresh `pnpm tauri init`-style minimal app under `tauri-port/poc/` (already exists as a scratch
   dir — do NOT touch main `src-tauri`). Pin Tauri v2 + `tauri-plugin-updater` (v2) + `serde_json`.
2. Generate a throwaway minisign keypair (`cargo tauri signer generate`); put the **public** key in
   the PoC `tauri.conf.json` `plugins.updater.pubkey`. Set `version` in `tauri.conf.json` to `0.1.0`.
3. Craft a tiny JSON manifest (`{"version":"0.2.0","notes":"poc","pub_date":"…","platforms":{…}}`)
   with a `signature` produced by signing a dummy (empty) artifact's `.sig` with the throwaway key,
   hosted on a local static server (`python3 -m http.server 8081`) so it is reachable and cheap.
   Endpoint under `plugins.updater.endpoints`.
4. `main.rs`: on startup call `updater.check()`. If `Some(update)` → print/emit
   `check() → available {version, notes}`; assert `update.version` == `0.2.0`; do **NOT** call
   `download`/`install`. If `None` → `up to date`. Also assert a **tampered** manifest (wrong pubkey)
   fails signature verification — confirming the minisign path is real, not decorative.
5. Deliverable of PoC: console output proving (a) Tauri JSON manifest parses, (b) version compare
   works against `tauri.conf.json` version, (c) signature verifies/rejects. That de-risks the schema
   + signing pipeline (the biggest unknown) before committing to option 1.

Out of scope for the PoC: install-lock cleanup, force gate, release-notes persistence, cancel. Those
are validated only in the full option-1 build.

---

## 7. Open unknowns (ASSUMPTION summary)

- Exact `tauri-plugin-updater` v2 API names and manifest `platforms` keys — verify against the
  Tauri version the port pins (**ASSUMPTION**, not in repo).
- Whether Tauri updater offers differential downloads — **ASSUMPTION: no**; current feed uses
  single-range differential (manifestUpdateProvider.ts:143-152, publish `useMultipleRangeRequest:false`),
  so parity may regress download size on Windows (~15MB diff → full pkg, per builder config comment).
- Real manifest/CDN endpoint URLs — external service, not committed (**ASSUMPTION**).
- Whether `bundle.createUpdaterArtifacts` NSIS customization can reproduce the patched
  `installSection.nsh` behavior — needs a Windows build check (**ASSUMPTION**).
