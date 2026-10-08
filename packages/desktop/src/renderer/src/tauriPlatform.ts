import type {
  DesktopTitleBarTheme,
  IPlatformService,
  Locale,
  TaskNotificationPayload,
} from "@zcode/shared";

import {
  createTempTextAttachment as bridgeCreateTempTextAttachment,
  getTauriDesktopZoomLevel,
  getTauriDeviceId,
  getTauriSystemLocale,
  listenTauriDesktopZoomChanged,
  listenTauriWindowFullscreenChanged,
  openExternal as bridgeOpenExternal,
  openPath as bridgeOpenPath,
  selectDirectory as bridgeSelectDirectory,
  setWindowTheme as bridgeSetWindowTheme,
  showOpenDialog as bridgeShowOpenDialog,
  showTaskNotification as bridgeShowTaskNotification,
} from "./tauriBridge.js";

/**
 * Tauri-side `IPlatformService` adapter — Phase 3, PART 1 (additive, not yet wired).
 *
 * This is the platform seam (`platform.ts:504-919`) reimplemented over the verified Tauri command
 * wrappers in `tauriBridge.ts`. It is built incrementally and gated on the product decisions in
 * `../tauri-port/GO-NO-GO.md`: it currently implements ONLY the methods fully backed by real,
 * verified commands. It deliberately returns a `Pick<IPlatformService, …>` — NOT a full
 * `IPlatformService` — so every implemented method is type-checked against the exact interface
 * signature while no unported method is required (no stubs / no `throw`-placeholders, per the port
 * no-stub rule and AGENTS.md "no code beyond necessity").
 *
 * Electron is untouched: nothing imports this yet; the runtime factory will only select it under
 * `isTauriRuntime()` in a later, gated slice once the hard blockers (Agent transport, CDP browser
 * view, updater, event push, binary-over-JSON, sync-IPC getters) are ported.
 *
 * Two mapping notes that are real logic, not pass-throughs:
 * - The interface's `selectDirectory`/`selectFile` return a SINGLE `string | null`, while the bridge
 *   pickers return `string[] | null`; the adapter unwraps `[0]` (and defaults `selectFiles` to `[]`).
 * - `DesktopTitleBarTheme = "light" | "dark" | "system"`; `"system"` maps to clearing the explicit
 *   window theme (`null` → follow the OS), matching how the setter treats an absent override.
 */
const MAIN_LABEL = "main";

/**
 * Injectable bridge dependencies so the adapter's transformation/delegation logic is unit-testable
 * without a live Tauri runtime. Defaults to the real `tauriBridge` wrappers (bound below). Each is
 * typed via `typeof` the real import, so a mock must match the genuine signature.
 */
export interface TauriPlatformDeps {
  createTempTextAttachment: typeof bridgeCreateTempTextAttachment;
  selectDirectory: typeof bridgeSelectDirectory;
  showOpenDialog: typeof bridgeShowOpenDialog;
  showTaskNotification: typeof bridgeShowTaskNotification;
  openExternal: typeof bridgeOpenExternal;
  getDesktopZoomLevel: typeof getTauriDesktopZoomLevel;
  getDeviceId: typeof getTauriDeviceId;
  setWindowTheme: typeof bridgeSetWindowTheme;
  getSystemLocale: typeof getTauriSystemLocale;
  openPath: typeof bridgeOpenPath;
  listenDesktopZoomChanged: typeof listenTauriDesktopZoomChanged;
  listenWindowFullscreenChanged: typeof listenTauriWindowFullscreenChanged;
}

const realDeps: TauriPlatformDeps = {
  createTempTextAttachment: bridgeCreateTempTextAttachment,
  selectDirectory: bridgeSelectDirectory,
  showOpenDialog: bridgeShowOpenDialog,
  showTaskNotification: bridgeShowTaskNotification,
  openExternal: bridgeOpenExternal,
  getDesktopZoomLevel: getTauriDesktopZoomLevel,
  getDeviceId: getTauriDeviceId,
  setWindowTheme: bridgeSetWindowTheme,
  getSystemLocale: getTauriSystemLocale,
  openPath: bridgeOpenPath,
  listenDesktopZoomChanged: listenTauriDesktopZoomChanged,
  listenWindowFullscreenChanged: listenTauriWindowFullscreenChanged,
};

/** The subset of `IPlatformService` currently ported; expand the `Pick` keys as slices land. */
export type TauriPlatformSubset = Pick<
  IPlatformService,
  | "selectDirectory"
  | "selectFile"
  | "selectFiles"
  | "openExternal"
  | "openInFileManager"
  | "openExternalFile"
  | "getDesktopZoomLevel"
  | "onDesktopZoomLevelChanged"
  | "onWindowFullscreenChanged"
  | "setTitleBarTheme"
  | "getSystemLocale"
  | "getDeviceId"
  | "showTaskNotification"
  | "createTempTextAttachment"
>;

/**
 * Synchronous-getter backing store (blocker #7, `SYNC-GETTER-SPIKE.md`). The interface exposes
 * `getDeviceId(): string` synchronously, but Tauri IPC is always async; the faithful equivalent of
 * Electron reading `process.env.ZCODE_DEVICE_ID` synchronously in main is to prefetch the value ONCE at
 * bootstrap (async) and serve it from this cache. `null` = not bootstrapped yet.
 */
let deviceIdCache: string | null = null;

/**
 * Await-init-before-expose contract: the runtime factory MUST `await bootstrapTauriPlatform()` BEFORE
 * it hands the platform object to the UI, so the synchronous getters are populated when first read
 * (mirrors the slice-32 host-connection "await connect before use" ordering). Uses the bridge wrappers
 * to fetch values that are needed synchronously downstream. Idempotent; safe to call once at boot.
 *
 * @param deps - Bridge wrappers to read from; defaults to the real `tauriBridge` functions.
 */
export async function bootstrapTauriPlatform(
  deps: TauriPlatformDeps = realDeps,
): Promise<void> {
  deviceIdCache = await deps.getDeviceId();
}

/** Reset the synchronous-getter cache. Test-only seam to keep b1 cases order-independent. */
export function resetTauriPlatformBootstrapForTesting(): void {
  deviceIdCache = null;
}

/**
 * Build the Tauri platform-adapter subset backed by the verified command wrappers.
 *
 * @param deps - Bridge wrappers to delegate to; defaults to the real `tauriBridge` functions. Tests
 *   inject fakes to assert the transformation and delegation logic without a Tauri runtime.
 * @returns An object whose members each satisfy the corresponding `IPlatformService` method
 *   signature (enforced by the `TauriPlatformSubset` `Pick`), delegating to a real Tauri `invoke`.
 */
export function createTauriPlatformSubset(
  deps: TauriPlatformDeps = realDeps,
): TauriPlatformSubset {
  return {
    async selectDirectory() {
      const paths = await deps.selectDirectory(false);
      return paths?.[0] ?? null;
    },
    async selectFile() {
      const paths = await deps.showOpenDialog({ multiple: false });
      return paths?.[0] ?? null;
    },
    async selectFiles() {
      const paths = await deps.showOpenDialog({ multiple: true });
      return paths ?? [];
    },
    openExternal(url: string): void {
      // Fire-and-forget like Electron's `shell.openExternal` (interface return is `void`). The
      // rejection is swallowed deliberately so a failed OS launch never becomes an unhandled
      // promise rejection; the interface contract is that callers do not await this.
      void deps.openExternal(url).catch(() => {});
    },
    async openInFileManager(path: string) {
      // FIX (slice 35): Electron's openInFileManager opens the path via `shell.openPath` /
      // `open` (desktopMainIpcHelpers.ts:66,101 — `openPathInFileManager`), NOT `showItemInFolder`
      // (reveal-select). Slice 28 mis-mapped it to showItemInFolder, which would reveal instead of
      // opening under Tauri. The faithful primitive is `openPath` (opener opens a dir in the file
      // manager) — the same seam openExternalFile uses; both are `shell.openPath`-based in Electron.
      // Maps the command's `Result<(),String>` seam onto the interface's `{success,error?}` object.
      try {
        await deps.openPath(path);
        return { success: true };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    },
    async openExternalFile(path: string) {
      // Maps the open-path command's `Result<(),String>` seam to the interface's
      // `{success,error?}` result object (same contract shape as openInFileManager).
      try {
        await deps.openPath(path);
        return { success: true };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    },
    async getDesktopZoomLevel() {
      const zoomLevel = await deps.getDesktopZoomLevel(MAIN_LABEL);
      return { zoomLevel };
    },
    async setTitleBarTheme(theme: DesktopTitleBarTheme) {
      await deps.setWindowTheme(MAIN_LABEL, theme === "system" ? null : theme);
    },
    async getSystemLocale() {
      return toSupportedLocale(await deps.getSystemLocale());
    },
    getDeviceId(): string {
      // Sync getter backed by the bootstrap prefetch (blocker #7). Returns "" ONLY if
      // bootstrapTauriPlatform() was not awaited before the platform was exposed — the runtime factory
      // enforces that ordering, so in practice the value is always present. Not a stub: the data comes
      // from the real `get_device_id` command, just delivered asynchronously and cached.
      return deviceIdCache ?? "";
    },
    showTaskNotification(payload: TaskNotificationPayload): void {
      // Fire-and-forget like Electron's `window.zcode.showTaskNotification` (an `ipcRenderer.send`,
      // interface return is `void`): destructure the payload onto the command's flat args and swallow
      // any delivery rejection, so a denied OS-permission never becomes an unhandled rejection. The
      // command itself applies the copy/focus/dedupe suppressions (slice 38). requestId is forwarded
      // verbatim (undefined stays undefined → bridge maps to null → Rust Option::None).
      void deps
        .showTaskNotification(
          payload.taskId,
          payload.status,
          payload.title,
          payload.body,
          payload.requestId,
        )
        .catch(() => {});
    },
    createTempTextAttachment(payload) {
      // Faithful delegation: the interface passes a CreateTempTextAttachmentRequest object; the command
      // takes positional args. The bridge returns a structurally-identical result (TauriTempTextAttachment
      // Result === CreateTempTextAttachmentResult), so it satisfies the Pick's expected return type.
      // `filename` stays `undefined` when absent -> the bridge maps it to null -> Rust Option::None.
      return deps.createTempTextAttachment(payload.text, payload.filename);
    },
    onDesktopZoomLevelChanged(handler) {
      // The interface returns a SYNCHRONOUS disposer, but Tauri's `listen` is async. Bridge them with
      // a settled flag: if the caller unsubscribes before `listen` resolves, invoke the unlisten the
      // moment it arrives (no leaked subscription); otherwise stash it for the disposer. Faithful to
      // Electron's sync-subscribe/async-teardown contract, not a no-op.
      let unlisten: (() => void) | undefined;
      let disposed = false;
      void deps.listenDesktopZoomChanged(handler).then((fn) => {
        if (disposed) {
          fn();
        } else {
          unlisten = fn;
        }
      });
      return () => {
        disposed = true;
        unlisten?.();
      };
    },
    onWindowFullscreenChanged(handler) {
      // Same async-listen / sync-disposer bridge as onDesktopZoomLevelChanged: forward the bare
      // boolean payload, and if the caller unsubscribes before `listen` resolves, tear the listener
      // down the moment it arrives (no leaked subscription). Faithful to Electron's sync-subscribe
      // contract. NOTE (parity residual): only shell-command-driven transitions fire the event, since
      // Tauri has no fullscreen WindowEvent — see commands.rs WINDOW_FULLSCREEN_CHANGED_EVENT doc.
      let unlisten: (() => void) | undefined;
      let disposed = false;
      void deps.listenWindowFullscreenChanged(handler).then((fn) => {
        if (disposed) {
          fn();
        } else {
          unlisten = fn;
        }
      });
      return () => {
        disposed = true;
        unlisten?.();
      };
    },
  };
}

/**
 * Narrow a raw OS locale string to the app's supported `Locale` union. Mirrors the exact rule in
 * `desktopApplicationMenu.ts:resolveSystemApplicationLocale` (`startsWith("zh") ? "zh-CN" : "en-US"`).
 * That Electron helper reads `app.getPreferredSystemLanguages()[0]` (a macOS quirk: `getLocale()` can
 * return en-US on a Chinese macOS); Tauri's `sys_locale` exposes a single locale, so the SOURCE differs
 * while the transformation rule is identical — a documented platform adaptation (PORTING.md), correct on
 * Linux and any non-Chinese-macOS case.
 *
 * @param raw - The raw OS locale string from `get_system_locale`.
 * @returns The supported `"zh-CN"` / `"en-US"` discriminator.
 */
export function toSupportedLocale(raw: string): Locale {
  return raw.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}
