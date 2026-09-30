/**
 * The preload for the CUA permission drag overlay.
 *
 * It exposes only the three things this overlay genuinely needs instead of reusing the main window's
 * heavyweight preload — the overlay is an unfocused window floating above System Settings, and the
 * smaller its attack surface the better.
 *
 * `startDrag` has to be a send rather than an invoke: Electron requires the native drag to start
 * synchronously within the dragstart event chain, and the promise round trip of an invoke misses
 * the OS drag gesture window, showing up as "you press and drag but nothing gets dragged out".
 */
import { contextBridge, ipcRenderer } from "electron";
import { PlatformChannels, type CuaPermissionKind, type Locale } from "@zcode/shared";

const CUA_PERMISSION_PANEL_STATE_CHANNEL = "zcode:cua-permission-panel-state";

interface CuaPermissionPanelState {
  permission: CuaPermissionKind;
  /** The current interface language of ZCode maintained by the main process; the floating window must not read the system language or localStorage. */
  locale: Locale;
  /** The real ZCode icon (data URL); if it cannot be read, it is null, and the page retains the placeholder graphic. */
  iconDataUrl: string | null;
}

contextBridge.exposeInMainWorld("cuaPermissionPanel", {
  /** Preheat the verified Helper path + fingerprint when mounting, so that subsequent dragstart can synchronize startDrag. */
  prepareDrag: () => ipcRenderer.invoke(PlatformChannels.PrepareCuaHelperPermissionDrag),
  /** Synchronously initiate native file drag and drop. Must be called directly in the dragstart handler. */
  startDrag: () => ipcRenderer.send(PlatformChannels.StartCuaHelperPermissionDrag),
  /** When the drag gesture ends, the floating window can be closed. */
  notifyDragEnded: () => ipcRenderer.send(PlatformChannels.NotifyCuaHelperPermissionDragEnded),
  /** Receives the current permission stage and application icon pushed by main, which is used to switch copywriting and tile icons. */
  onState: (callback: (state: CuaPermissionPanelState) => void) => {
    const listener = (_event: unknown, payload: CuaPermissionPanelState) => callback(payload);
    ipcRenderer.on(CUA_PERMISSION_PANEL_STATE_CHANNEL, listener);
    return () => ipcRenderer.removeListener(CUA_PERMISSION_PANEL_STATE_CHANNEL, listener);
  },
});
