# SYNC-GETTER-SPIKE: synchronous `IPlatformService` getters over async Tauri IPC

Read-only spike. Resolves the named hard-blocker **"sync-IPC getters"** (listed in
`PLATFORM-ADAPTER-PLAN.md` / the GO-NO-GO blocker set): several `IPlatformService` methods return a value
**synchronously**, but every renderer→main Tauri `invoke` is a `Promise`. This blocks mapping an
otherwise-landed command (`get_device_id`) into the adapter `Pick`. The spike decides the pattern and
pins the ordering contract the runtime factory (task #45, gated) MUST honor so the follow-up slice is
correct rather than timing-fragile.

## The sync getters (evidence)

`packages/shared/src/platform.ts`, interface `IPlatformService` (:504+):

| Method | Line | Returns | Backing today | Real blocker |
| --- | --- | --- | --- | --- |
| `getDeviceId()` | :918 | `string` (sync) | **landed** `get_device_id` command (reads env `ZCODE_DEVICE_ID`, `commands.rs:137`) + `getTauriDeviceId(): Promise<string>` wrapper (`tauriBridge.ts:46`) | **this spike only** — pure async→sync delivery |
| `getWindowControlsOverlayMetrics?()` | (WCO) | `WindowControlsOverlayMetrics \| null` (sync) | — | possibly **local** `navigator.windowControlsOverlay` (see below), maybe no IPC |
| `createLocalMediaPreviewUrl?()` | :533 | `string` (sync) | — | **separate** capability gap (asset/media protocol) — see [`WEBVIEW-PROTOCOL-SPIKE.md`](./WEBVIEW-PROTOCOL-SPIKE.md) #5 |
| `getPathForFile?()` | :530 | `string \| null` (sync) | — | **separate** capability gap (DOM `File`→absolute path unavailable in Tauri without drag-drop) |

So this spike owns **`getDeviceId`** (the only one whose command is already landed and whose ONLY gap is
sync delivery) and clarifies that the other three are gated by *other*, unrelated blockers.

## Why the naive mapping fails

The adapter (a `Pick<IPlatformService,…>`) is type-checked against the exact signature, so `getDeviceId`
must return `string`, not `Promise<string>`. Returning `getTauriDeviceId()` (a Promise) is a type error,
and `await`ing inside a non-async sync getter is impossible. `createTauriPlatformSubset` (see
`tauriPlatform.ts`) therefore cannot wire it like the async methods were.

## Recommended pattern: prefetch-at-init + synchronous cache

Populate the value once during renderer bootstrap (async), then serve it synchronously from a module-level
cache. Faithful because Electron's own sync getters are backed by a value that is *already known* at
startup (env in main); the Tauri equivalent reads it once at init and freezes it.

```ts
// tauriPlatform.ts (sketch)
let deviceIdCache: string | null = null;

/** Called ONCE by the runtime factory BEFORE installing the platform (ordering contract below). */
export async function bootstrapTauriPreload(deps): Promise<void> {
  deviceIdCache = await deps.getDeviceId(); // invoke -> get_device_id
}

// adapter Pick member:
getDeviceId(): string {
  return deviceIdCache ?? ""; // contract guarantees cache is set before any UI read
}
```

### The ordering contract (the crux — MUST be honored by the factory)

The sync getter is only faithful if the cache is populated **before any caller reads it**. Electron's
main reads env synchronously and is always correct; the Tauri prefetch has a startup window where the
cache is empty. The contract that closes this:

1. The runtime factory awaits `bootstrapTauriPreload()` to completion **before** it installs/returns the
   `IPlatformService` (i.e., before `getPlatform()` resolves and before any UI can render/call the
   adapter).
2. Any value needed synchronously at first paint (device id) must be part of this awaited bootstrap, not
   a later lazy fetch.

This is exactly the shape `tauriHostConnection.ts` (slice 32) already models for the async sidecar-Host
connect-then-use ordering — reuse that "await init before exposing the seam" precedent.

### Alternative considered and rejected for `getDeviceId`

- **`initialization_script` injection**: have Rust compute the value and inject `window.__ZCODE_DEVICE_ID__`
  via `WebviewWindowBuilder::initialization_script` (mechanism validated in
  `WEBVIEW-PROTOCOL-SPIKE.md` §4.2). True sync, present from first paint. BUT: (a) the main window is
  currently declared in `tauri.conf.json`, so this needs a programmatic-window or conf change to the shell
  bootstrap; (b) it cannot be verified headlessly (whether the injected script actually runs in the live
  webview needs `pnpm dev:tauri`). Chosen as the fallback if a value must exist at *first paint* before any
  await; for device-id (read after init) the prefetch cache is simpler and testable.
- **Cache with a lazy "not ready yet" default**: returns `""` before first resolve — an acceptable
  degradation ONLY if the factory honors the ordering contract above; otherwise a fidelity gap. Rejected
  as the sole mechanism (no ordering guarantee) but it IS what the contract makes safe.

## `getWindowControlsOverlayMetrics` — likely needs NO IPC

Window-Controls-Overlay is a **browser API** (`navigator.windowControlsOverlay.getWindowTitlebarAreaRect()`
/ `.visible`), readable synchronously in the renderer. Electron's main-side version likely derives frame
insets for its custom title bar; under Tauri the renderer may compute it locally. **Follow-up:** read the
Electron impl to confirm whether it uses native insets (→ would need a `get_window_*`-style command, still
async → same prefetch pattern) or the DOM WCO API (→ a direct local sync read in the adapter, no bootstrap
needed). Do NOT assume; verify before wiring.

## Forbidden shortcuts

- Do NOT change the interface `getDeviceId(): string` to async just to make it wire — that violates
  behavior parity (AGENTS port rule) and ripples into every caller.
- Do NOT add `getDeviceId` to the `Pick` returning `""` with no bootstrap ordering — a silent
  correctness bug (callers get an empty device id). The Pick means "faithfully implemented"; a getter that
  can return the wrong value is not that. Wire it only WITH the factory's ordering guarantee in place
  (task #45), or hold it out of the Pick exactly like other unbacked methods.

## Effort / risk / next step

- **Effort**: LOW for `getDeviceId` once the factory exists (a bootstrap fn + a cache + the Pick member +
  a b1 test: unset→default, after-bootstrap→value). The real cost is the factory ordering it depends on.
- **Risk**: MED if the ordering contract is violated (returns default); the contract + a startup assert
  make it safe.
- **Concrete next slice** (when #45 factory lands): implement `bootstrapTauriPreload`, wire `getDeviceId`
  into the `Pick` reading the cache, add the b1 delegation + before/after-bootstrap test. Until then,
  `getDeviceId` stays out of the `Pick` (no stub), and this doc records the exact recipe + contract.

## Files read

- `packages/shared/src/platform.ts` (`getDeviceId` :918; `getPathForFile` :530; `createLocalMediaPreviewUrl`
  :533; WCO `getWindowControlsOverlayMetrics` in the interface body)
- `packages/desktop/src-tauri/src/commands.rs:137` (`get_device_id`, env-backed)
- `packages/desktop/src/renderer/src/tauriBridge.ts:46` (`getTauriDeviceId(): Promise<string>`)
- `packages/desktop/src/renderer/src/tauriPlatform.ts` (adapter `Pick` + injectable-deps pattern)
- `packages/desktop/src/renderer/src/tauriHostConnection.ts` (await-init-before-use ordering precedent)
- `packages/desktop/tauri-port/WEBVIEW-PROTOCOL-SPIKE.md` (§4 init-script mechanism; #5 media protocol)
