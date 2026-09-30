import { useSyncExternalStore } from "react";
import { isAppleKeyboardPlatform } from "@/lib/keyboardShortcuts.js";
import { isPrimaryFollowupModifierPressed } from "@/v4/composer/followupModeSettings.js";

const listeners = new Set<() => void>();
let pressed = false;
let detachWindowListeners: (() => void) | null = null;

function publish(next: boolean): void {
  if (pressed === next) return;
  pressed = next;
  for (const listener of listeners) listener();
}

function attachWindowListeners(): () => void {
  const syncModifier = (event: KeyboardEvent) => {
    publish(
      isPrimaryFollowupModifierPressed({
        isApplePlatform: isAppleKeyboardPlatform(),
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
      }),
    );
  };
  const clearModifier = () => publish(false);
  window.addEventListener("keydown", syncModifier);
  window.addEventListener("keyup", syncModifier);
  window.addEventListener("blur", clearModifier);
  return () => {
    window.removeEventListener("keydown", syncModifier);
    window.removeEventListener("keyup", syncModifier);
    window.removeEventListener("blur", clearModifier);
    pressed = false;
  };
}

/**
 * Split-screen and multi-window content trees may have multiple Composers mounted at the same time. The modifier key is window fact,
 * Each Composer is bound to a set of keydown/keyup and will be processed repeatedly; here a single external store is used to broadcast the transient state.
 */
function subscribePrimaryFollowupModifier(listener: () => void): () => void {
  listeners.add(listener);
  if (!detachWindowListeners && typeof window !== "undefined") {
    detachWindowListeners = attachWindowListeners();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && detachWindowListeners) {
      detachWindowListeners();
      detachWindowListeners = null;
    }
  };
}

function getPrimaryFollowupModifierSnapshot(): boolean {
  return pressed;
}

export function usePrimaryFollowupModifier(): boolean {
  return useSyncExternalStore(
    subscribePrimaryFollowupModifier,
    getPrimaryFollowupModifierSnapshot,
    () => false,
  );
}
