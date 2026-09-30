/**
 * Shortcut display label — binding string → platform-specific display formatting. Split out of
 * bindings.ts (the presentation layer is independent of matching/recording/conflicts, and
 * bindings.ts has a max-lines gate).
 */
import { parseShortcutBinding } from "@zcode/shared";

import {
  isAppleKeyboardPlatform,
  type KeyboardShortcutPlatformInfo,
} from "../lib/keyboardShortcuts.js";

/**
 * Binding string → per-key tokens (for rendering keycaps in settings): macOS ["⇧","⌘","P"],
 * Windows/Linux ["Ctrl","Shift","P"]. Label display and keycap rendering share the same token
 * sequence, and this is the only place the ordering convention is defined; each token renders its
 * own Kbd keycap, which is what keeps the size from drifting with the content.
 */
export function formatShortcutBindingLabelParts(
  binding: string,
  platformInfo?: KeyboardShortcutPlatformInfo,
): string[] {
  const parsed = parseShortcutBinding(binding);
  if (parsed === null) {
    return [binding];
  }

  const displayKey =
    parsed.key === "=" ? "+" : parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key;
  const isApple = isAppleKeyboardPlatform(platformInfo);

  if (isApple) {
    // Apple's customary modifier key sequence: ⌃ ⌥ ⇧ ⌘
    const parts: string[] = [];
    if (parsed.altGr) {
      parts.push("⌃", "⌥");
    } else {
      if (parsed.ctrl) {
        parts.push("⌃");
      }
      if (parsed.alt) {
        parts.push("⌥");
      }
    }
    if (parsed.shift) {
      parts.push("⇧");
    }
    if (parsed.cmdOrCtrl) {
      parts.push("⌘");
    }
    parts.push(displayKey);
    return parts;
  }

  const parts: string[] = [];
  if (parsed.cmdOrCtrl || parsed.ctrl) {
    parts.push("Ctrl");
  }
  if (parsed.altGr) {
    parts.push("Alt");
  } else if (parsed.alt) {
    parts.push("Alt");
  }
  if (parsed.shift) {
    parts.push("Shift");
  }
  parts.push(displayKey);
  return parts;
}

/**
 * Binding string → platform display label. macOS uses the symbol style (⌘ K, ⌃ ⌥ ⇧ ⌘ P) and
 * Windows/Linux the Ctrl+Shift+P style; "=" is displayed as "+" (zoom semantics), and named keys
 * are kept as-is.
 */
export function formatShortcutBindingLabel(
  binding: string,
  platformInfo?: KeyboardShortcutPlatformInfo,
): string {
  return formatShortcutBindingLabelParts(binding, platformInfo).join(
    isAppleKeyboardPlatform(platformInfo) ? " " : "+",
  );
}
