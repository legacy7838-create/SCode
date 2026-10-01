/**
 * Desktop window surface — the OS window half of `IPlatformService`.
 *
 * Split out of `tauriPlatform.ts` because these members share one owner (the
 * frameless window) and one failure mode (the buttons silently no-op). Keeping
 * them together is also what makes the "drives the real OS window" property
 * reviewable in one place rather than scattered through a 600-line adapter.
 *
 * The frameless window draws its own titlebar + controls (see
 * `DesktopWindowControls`), so `executeDesktopCommand` must reach Tauri's window
 * API — otherwise minimize/maximize/close do nothing at all.
 */
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import { DesktopCommandIds, type DesktopCommandId, type DesktopWindowChromeState } from "@zcode/shared";

/** True when the Tauri IPC bridge is present (i.e. running inside the app, not a bare browser tab). */
function hasTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Nudge the page zoom by `delta`, reading the last value back from the Rust
 * side so repeated presses accumulate against the real state, not a local copy.
 *
 * The Rust registry is the owner (`commands/surface.rs` persists it), which is
 * why this reads before it writes instead of keeping a renderer-side counter.
 */
async function adjustZoom(delta: number): Promise<void> {
  const current = await invoke<number>("get_desktop_zoom").catch(() => 1);
  const next = Math.max(0.3, Math.min(3, current + delta));
  await invoke("set_desktop_zoom", { factor: next }).catch(() => {});
}

/** The chrome state Tauri's window API can actually answer; the rest is desktop-only. */
const CHROME: Omit<DesktopWindowChromeState, "isMaximized"> = {
  macOSMajorVersion: null,
  supportsNativeRoundedCorners: false,
};

export async function executeDesktopCommand(command: DesktopCommandId): Promise<unknown> {
  if (!hasTauri()) return undefined;
  const win = getCurrentWindow();
  try {
    switch (command) {
      case DesktopCommandIds.MinimizeWindow:
        await win.minimize();
        return undefined;
      case DesktopCommandIds.ToggleMaximizeWindow:
        await win.toggleMaximize();
        return undefined;
      case DesktopCommandIds.CloseWindow:
        await win.close();
        return undefined;
      case DesktopCommandIds.ToggleFullScreen:
        await win.setFullscreen(!(await win.isFullscreen()));
        return undefined;
      case DesktopCommandIds.ResetWindowSize:
        await win.setSize(new LogicalSize(1280, 820));
        await win.center();
        return undefined;
      case DesktopCommandIds.ZoomIn:
        await adjustZoom(0.1);
        return undefined;
      case DesktopCommandIds.ZoomOut:
        await adjustZoom(-0.1);
        return undefined;
      case DesktopCommandIds.ResetZoom:
        await invoke("set_desktop_zoom", { factor: 1 }).catch(() => {});
        return undefined;
      default:
        // No native equivalent (About/Changelog/Updates/…); safe no-op.
        return undefined;
    }
  } catch (cause) {
    console.warn(`[tauri-window] executeDesktopCommand(${command}) failed`, cause);
    return undefined;
  }
}

export async function getDesktopWindowChromeState(): Promise<DesktopWindowChromeState> {
  if (!hasTauri()) return { isMaximized: false, ...CHROME };
  const isMaximized = await getCurrentWindow()
    .isMaximized()
    .catch(() => false);
  return { isMaximized, ...CHROME };
}

/**
 * Subscribe to maximize/restore. Both surface as an OS resize, so the listener
 * is `onResized` rather than a maximize event — Tauri has no dedicated one.
 */
export function onDesktopWindowChromeStateChanged(
  handler: (state: DesktopWindowChromeState) => void,
): () => void {
  if (!hasTauri()) return () => {};
  const win = getCurrentWindow();
  let disposed = false;
  let unlisten: (() => void) | null = null;
  const emit = () => {
    void win
      .isMaximized()
      .then((isMaximized) => {
        if (!disposed) handler({ isMaximized, ...CHROME });
      })
      .catch(() => {});
  };
  void win.onResized(emit).then((fn) => {
    if (disposed) fn();
    else unlisten = fn;
  });
  return () => {
    disposed = true;
    unlisten?.();
  };
}

/**
 * Subscribe to fullscreen changes. `last` suppresses the duplicate emit a
 * resize produces when the window is resized *and* toggled by the same action,
 * so the handler sees a transition rather than a repeat.
 */
export function onWindowFullscreenChanged(handler: (isFullscreen: boolean) => void): () => void {
  if (!hasTauri()) return () => {};
  const win = getCurrentWindow();
  let disposed = false;
  let unlisten: (() => void) | null = null;
  let last: boolean | null = null;
  const emit = () => {
    void win
      .isFullscreen()
      .then((isFullscreen) => {
        if (!disposed && isFullscreen !== last) {
          last = isFullscreen;
          handler(isFullscreen);
        }
      })
      .catch(() => {});
  };
  void win.onResized(emit).then((fn) => {
    if (disposed) fn();
    else unlisten = fn;
  });
  return () => {
    disposed = true;
    unlisten?.();
  };
}

/**
 * The window this renderer belongs to. Its label is the key every Rust-side
 * registry is indexed by; the command layer derives the caller from an injected
 * `WebviewWindow`, never from a payload field.
 */
export const currentWindowLabel = (): string =>
  hasTauri() ? getCurrentWebviewWindow().label : "main";