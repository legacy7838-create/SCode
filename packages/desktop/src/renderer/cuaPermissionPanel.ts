import type {
  CuaPermissionKind,
  Locale,
  PrepareCuaHelperPermissionDragResult,
} from "@zcode/shared";
import { resolveCuaPermissionPanelMessages } from "./cuaPermissionPanelMessages.js";

interface CuaPermissionPanelState {
  permission: CuaPermissionKind;
  locale: Locale;
  iconDataUrl: string | null;
}

declare global {
  interface Window {
    cuaPermissionPanel?: {
      prepareDrag?(): Promise<PrepareCuaHelperPermissionDragResult>;
      startDrag?(): void;
      notifyDragEnded?(): void;
      onState?(callback: (state: CuaPermissionPanelState) => void): () => void;
    };
  }
}

const bridge = window.cuaPermissionPanel;
const tile = document.getElementById("tile");
const hintPrefix = document.getElementById("hintPrefix");
const permissionLabel = document.getElementById("permissionLabel");
const hintSuffix = document.getElementById("hintSuffix");
const completion = document.getElementById("completion");
const icon = document.querySelector<HTMLElement>(".icon");

// Mounting means preheating: install+verify is asynchronous and must be completed before the user starts dragging.
// Otherwise, dragging cannot be initiated synchronously in dragstart (the gesture window will be missed while waiting for I/O).
// By the way, get back the real display name of the Helper - the tile must display it instead of a hard-coded string,
// Because the name of the row in the macOS permission list is this value (with the Dev suffix under dev),
// Only when both sides are consistent can the user confirm that "the one dragged in is it."
bridge
  ?.prepareDrag?.()
  .then((result) => {
    const appName = document.getElementById("appName");
    if (result?.helperDisplayName && appName) {
      appName.textContent = result.helperDisplayName;
    }
  })
  .catch(() => {});

bridge?.onState?.((state) => {
  const messages = resolveCuaPermissionPanelMessages(state.permission);
  document.documentElement.lang = state.locale;
  document.title = messages.documentTitle;
  if (tile) tile.title = messages.dragTitle;
  if (hintPrefix) hintPrefix.textContent = messages.hintPrefix;
  if (permissionLabel) permissionLabel.textContent = messages.permissionLabel;
  if (hintSuffix) hintSuffix.textContent = messages.hintSuffix;
  if (completion) completion.textContent = messages.completion;
  // Replace the placeholder gradient with a real ZCode icon, consistent with the icon in the row in the system settings list.
  if (state.iconDataUrl && icon) {
    icon.style.backgroundImage = `url("${state.iconDataUrl}")`;
  }
});

let dragStarted = false;

tile?.addEventListener("dragstart", (event) => {
  // HTML5 default drag and drop must be prevented, and main uses webContents.startDrag to initiate native file drag and drop——
  // Only native drag sessions can be accepted by the system-set permission list.
  event.preventDefault();
  dragStarted = true;
  bridge?.startDrag?.();
});

// After dragging the authorization, it is completed, and the floating window should give way. Use drag to end instead of closing the window in dragstart: startDrag just
// By handing the drag session to the OS (non-blocking), the drag source disappears immediately and may interrupt ongoing dragging.
const notifyDragEnded = () => {
  if (!dragStarted) return; // If you just click it without dragging it, you should not close the window.
  dragStarted = false;
  bridge?.notifyDragEnded?.();
};

// Whether dragend is still triggered after preventDefault depends on the Electron implementation, so use mouseup to take another step.
// (Mouse events return to the page after the native drag session ends). Both signals are subject to dragStarted, and main
// Side hide is idempotent and duplicate notifications are harmless. There is still freezePosition when no signal is received: the floating window will not run around.
tile?.addEventListener("dragend", notifyDragEnded);
document.addEventListener("mouseup", notifyDragEnded);
