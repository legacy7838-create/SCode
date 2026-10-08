import type { DesktopTitleBarTheme, IPlatformService } from "@zcode/shared";

import {
  getTauriDesktopZoomLevel,
  openExternal as bridgeOpenExternal,
  selectDirectory as bridgeSelectDirectory,
  setWindowTheme as bridgeSetWindowTheme,
  showOpenDialog as bridgeShowOpenDialog,
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
  selectDirectory: typeof bridgeSelectDirectory;
  showOpenDialog: typeof bridgeShowOpenDialog;
  openExternal: typeof bridgeOpenExternal;
  getDesktopZoomLevel: typeof getTauriDesktopZoomLevel;
  setWindowTheme: typeof bridgeSetWindowTheme;
}

const realDeps: TauriPlatformDeps = {
  selectDirectory: bridgeSelectDirectory,
  showOpenDialog: bridgeShowOpenDialog,
  openExternal: bridgeOpenExternal,
  getDesktopZoomLevel: getTauriDesktopZoomLevel,
  setWindowTheme: bridgeSetWindowTheme,
};

/** The subset of `IPlatformService` currently ported; expand the `Pick` keys as slices land. */
export type TauriPlatformSubset = Pick<
  IPlatformService,
  | "selectDirectory"
  | "selectFile"
  | "selectFiles"
  | "openExternal"
  | "getDesktopZoomLevel"
  | "setTitleBarTheme"
>;

/**
 * Build the Tauri platform-adapter subset backed by the verified command wrappers.
 *
 * @param deps - Bridge wrappers to delegate to; defaults to the real `tauriBridge` functions. Tests
 *   inject fakes to assert the transformation and delegation logic without a Tauri runtime.
 * @returns An object whose members each satisfy the corresponding `IPlatformService` method
 *   signature (enforced by the `TauriPlatformSubset` `Pick`), delegating to a real Tauri `invoke`.
 */
export function createTauriPlatformSubset(deps: TauriPlatformDeps = realDeps): TauriPlatformSubset {
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
    async getDesktopZoomLevel() {
      const zoomLevel = await deps.getDesktopZoomLevel(MAIN_LABEL);
      return { zoomLevel };
    },
    async setTitleBarTheme(theme: DesktopTitleBarTheme) {
      await deps.setWindowTheme(MAIN_LABEL, theme === "system" ? null : theme);
    },
  };
}
