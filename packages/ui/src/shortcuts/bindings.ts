/**
 * Shortcut execution kernel —— the single implementation of matching, capture, the effective table
 * and conflict detection.
 *
 * - Key knowledge (format parsing, platform modifier semantics, reserved keys) may exist only in
 *   this module and in shared/shortcutCommands.ts;
 * - Everything is a pure function, with DOM events passed in as structured arguments so unit tests
 *   can cover the chord boundaries;
 * - IME composition (isComposing / Process / Dead / keyCode 229) and long-press repeat never match
 *   and are never captured.
 */
import {
  type ParsedShortcutBinding,
  type ShortcutCommandId,
  parseShortcutBinding,
  serializeShortcutBinding,
  SHORTCUT_COMMANDS,
} from "@zcode/shared";
import {
  isAppleKeyboardPlatform,
  type KeyboardShortcutPlatformInfo,
} from "@/lib/keyboardShortcuts.js";
import { logger } from "@/logger.js";

/**
 * The keyboard event shape needed for matching/capture (a subset of KeyboardEvent that tests can
 * construct).
 */
export interface ShortcutBindingEvent {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  /**
   * For the legacy event model; during IME composition with Chinese and other IMEs, Chromium
   * reports keyCode 229.
   */
  keyCode?: number;
}

// ============================================================================
// Noise filtering (IME / long press)
// ============================================================================

/** Whether an event is an IME-composition event (isComposing / Process / Dead / keyCode 229). */
function isImeEvent(event: ShortcutBindingEvent): boolean {
  return (
    event.isComposing === true ||
    event.key === "Process" ||
    event.key === "Dead" ||
    event.keyCode === 229
  );
}

/**
 * Whether an event is noise that must not trigger a shortcut: long-press repeat, IME composition,
 * dead keys.
 */
function isShortcutEventNoise(event: ShortcutBindingEvent): boolean {
  return event.repeat === true || isImeEvent(event);
}

// ============================================================================
// event.code → canonical keyname mapping (reliable source for keyboard layout differences)
// ============================================================================

const CODE_TO_KEY: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    Array.from({ length: 26 }, (_, index) => [
      `Key${String.fromCharCode(65 + index)}`,
      String.fromCharCode(97 + index),
    ]),
  ),
  ...Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`Digit${index}`, String(index)])),
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [`F${index + 1}`, `F${index + 1}`]),
  ),
  BracketLeft: "[",
  BracketRight: "]",
  Equal: "=",
  Minus: "-",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Backslash: "\\",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  // Enter for composer scoped commands to record/match; NumpadEnter is not mapped (leaving undefined behavior)
  Enter: "Enter",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Delete: "Delete",
  Insert: "Insert",
};

/**
 * Canonical key name → the expected event.code (an extended version of the existing
 * keyboardShortcuts.getExpectedShortcutCode).
 */
const KEY_TO_CODE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(CODE_TO_KEY).map(([code, key]) => [key, code]),
);

// ============================================================================
// universal matcher
// ============================================================================

/**
 * General matching: whether a binding (canonical serialized string) hits a keyboard event.
 *
 * Modifiers are matched exactly: the modifiers actually held down by the event must match the
 * binding's declaration completely; an extra modifier (e.g. Cmd+Ctrl+K hitting CmdOrCtrl+K) does
 * not count as a hit.
 * - CmdOrCtrl: macOS = meta and no ctrl; Windows/Linux = ctrl and no meta (platform isolation is
 *   reused from keyboardShortcuts.ts);
 * - Ctrl: an explicit Ctrl; on Windows/Linux it is synonymous with CmdOrCtrl (capture only ever
 *   produces CmdOrCtrl on those platforms);
 * - AltGr: on Windows/Linux the physical AltGr is reported by Chromium as ctrl+alt held together.
 */
export function matchesShortcutBinding(
  event: ShortcutBindingEvent,
  binding: string,
  platformInfo?: KeyboardShortcutPlatformInfo,
): boolean {
  if (isShortcutEventNoise(event)) {
    return false;
  }
  const parsed = parseShortcutBinding(binding);
  if (parsed === null) {
    return false;
  }

  const isApple = isAppleKeyboardPlatform(platformInfo);
  if (!modifiersMatch(event, parsed, isApple)) {
    return false;
  }
  return eventMatchesKey(event, parsed.key);
}

function modifiersMatch(
  event: ShortcutBindingEvent,
  parsed: ParsedShortcutBinding,
  isApple: boolean,
): boolean {
  const { metaKey: meta, ctrlKey: ctrl, altKey: alt, shiftKey: shift } = event;

  // AltGr and Ctrl+Alt are physically indistinguishable (existing bindings such as Windows/Linux's Ctrl+Alt+B are the same press),
  // Therefore, the AltGr binding matches the same physical combination as the cmdOrCtrl/ctrl + Alt binding, and no exclusive determination is made.
  const wantPrimaryOrCtrl = parsed.altGr || parsed.cmdOrCtrl || (!isApple && parsed.ctrl);
  const wantCtrl = !parsed.altGr && !parsed.cmdOrCtrl && parsed.ctrl && isApple;
  const wantAlt = parsed.altGr || parsed.alt;

  // Naked key bindings (Enter/F5/arrow keys without main modifier keys) must require the main modifier key to be raised.
  // Otherwise, Cmd+Enter will accidentally hit the naked Enter binding - this gap is latent when the command list is full of primary modifier keys, and Enter will be fatal after entering the list.
  if (!wantPrimaryOrCtrl && !wantCtrl && (meta || ctrl)) {
    return false;
  }

  if (wantPrimaryOrCtrl) {
    const ok = isApple ? meta && !ctrl : ctrl && !meta;
    if (!ok) {
      return false;
    }
  }
  if (wantCtrl) {
    // macOS explicit Ctrl (system Emacs editing reserved area, user explicit binding will take effect).
    if (!ctrl || meta) {
      return false;
    }
  }
  if (wantAlt !== alt) {
    return false;
  }
  return parsed.shift === shift;
}

/**
 * Whether a binding is purely Shift plus a printable single character (e.g. Shift+f). Such a
 * binding is the same physical event as “typing an uppercase letter”; when the event target is an
 * editable element it must be let through, otherwise the user cannot type that uppercase letter in
 * a text field (the keystroke is swallowed by preventDefault and triggers the command instead).
 */
export function isShiftOnlyPrintableBinding(binding: string): boolean {
  const parsed = parseShortcutBinding(binding);
  if (parsed === null) {
    return false;
  }
  return (
    !parsed.cmdOrCtrl &&
    !parsed.ctrl &&
    !parsed.alt &&
    !parsed.altGr &&
    parsed.shift &&
    parsed.key.length === 1
  );
}

/**
 * Whether the target of a shortcut event is an editable element (input/textarea/select or
 * contenteditable). Pairs with isShiftOnlyPrintableBinding: pure Shift printable-key bindings are
 * skipped inside editable targets. Always false in a DOM-less environment (node unit tests).
 */
export function isEditableShortcutEventTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Key matching: a lowercased event.key comparison first, event.code as the fallback (macOS Option
 * rewriting, non-US layouts).
 */
function eventMatchesKey(event: Pick<ShortcutBindingEvent, "key" | "code">, key: string): boolean {
  if (event.key === key) {
    return true;
  }
  if (event.key.length === 1 && event.key.toLowerCase() === key) {
    return true;
  }
  if (event.code !== undefined) {
    return KEY_TO_CODE[key] === event.code;
  }
  return false;
}

// ============================================================================
// recorder
// ============================================================================

type ShortcutRecordResult =
  | { kind: "pending" }
  | { kind: "binding"; binding: string }
  | { kind: "invalid"; reason: "no-modifier" | "unsupported-key" };

function isModifierOnlyKey(key: string): boolean {
  return (
    key === "Shift" ||
    key === "Control" ||
    key === "Meta" ||
    key === "Alt" ||
    key === "AltGraph" ||
    key === "OS"
  );
}

/**
 * Capture a keyboard event as a canonical binding string.
 *
 * - pending: a bare modifier key press / IME noise with no reverse-lookupable code — keep waiting
 *   for the user to press the full combination;
 * - binding: a valid combination (the primary modifier is normalized per platform: Cmd on mac, Ctrl
 *   on win/linux → CmdOrCtrl; an explicit Ctrl on mac stays Ctrl);
 * - invalid: a plain key with no modifier (F-keys and arrow keys excepted) or an unsupported key.
 *
 * Key-name extraction prefers reverse-looking-up the physical base key from event.code (Shift+7
 * records “7” rather “&” on any layout), with event.key only as a fallback. The key of an IME
 * composition event (isComposing/Process/229) is untrustworthy, but event.code is still the
 * physical key — capture is an explicit intent following a click on the capture button; with a
 * Chinese IME on, if the focus sits in an editable element, Shift+letter is swallowed by the IME
 * into composition input, and it is still recorded by code (the matching side keeps filtering as
 * before, see isShortcutEventNoise). The capture-state semantics of Escape / Backspace (cancel /
 * clear) are handled by the settings page UI.
 */
export function recordShortcutBinding(
  event: ShortcutBindingEvent,
  platformInfo?: KeyboardShortcutPlatformInfo,
): ShortcutRecordResult {
  if (event.repeat === true || isModifierOnlyKey(event.key)) {
    return { kind: "pending" };
  }

  if (isImeEvent(event)) {
    const codeKey = event.code !== undefined ? CODE_TO_KEY[event.code] : undefined;
    if (codeKey === undefined) {
      return { kind: "pending" };
    }
    return buildRecordedBinding(event, codeKey, platformInfo);
  }

  const key =
    event.code !== undefined
      ? (CODE_TO_KEY[event.code] ?? normalizeEventKey(event.key))
      : normalizeEventKey(event.key);
  if (key === null) {
    return { kind: "invalid", reason: "unsupported-key" };
  }
  return buildRecordedBinding(event, key, platformInfo);
}

/**
 * The tail of capture: modifier validation + platform normalization + serialization (the key name
 * is already extracted by the caller).
 */
function buildRecordedBinding(
  event: ShortcutBindingEvent,
  key: string,
  platformInfo?: KeyboardShortcutPlatformInfo,
): ShortcutRecordResult {
  const isApple = isAppleKeyboardPlatform(platformInfo);
  const hasModifier = event.metaKey || event.ctrlKey || event.altKey || event.shiftKey;
  // Named keys (multi-character) such as F keys/arrow keys allow unmodified single keys; ordinary character keys must have at least one modifier key.
  const namedKey = key.length > 1;
  if (!hasModifier && !namedKey) {
    return { kind: "invalid", reason: "no-modifier" };
  }

  const parsed: ParsedShortcutBinding = {
    // AltGr and Ctrl+Alt are physically indistinguishable, and recording uniformly outputs CmdOrCtrl+Alt (what the user presses mentally is Ctrl+Alt).
    cmdOrCtrl: isApple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey,
    ctrl: isApple ? event.ctrlKey && !event.metaKey : false,
    alt: event.altKey,
    shift: event.shiftKey,
    altGr: false,
    key,
  };

  // The Cmd+Ctrl+ combination of mac and the pure Meta (Win key) combination of win/linux are normalized by the platform
  // cmdOrCtrl/ctrl both return false, and the hasModifier above uses the original event to verify that it has been released, and the serialized product will become
  // Naked single key (such as "k") - no longer retains the blacklist, does not trigger conflict detection, and will be hit every time the key is pressed naked after the disk is placed.
  // command and swallow the input. Verify that the primary modifier key is not lost during normalization before serialization.
  if ((event.metaKey || event.ctrlKey) && !parsed.cmdOrCtrl && !parsed.ctrl) {
    return { kind: "invalid", reason: "unsupported-key" };
  }

  const binding = serializeShortcutBinding(parsed);
  if (binding === null) {
    return { kind: "invalid", reason: "unsupported-key" };
  }
  return { kind: "binding", binding };
}

/**
 * event.key → canonical key name (fallback path only): single characters lowercased, named keys
 * left as-is.
 */
function normalizeEventKey(rawKey: string): string | null {
  if (rawKey.length === 1) {
    return /^[a-zA-Z0-9[\]=\-,./;'\\`]$/.test(rawKey) ? rawKey.toLowerCase() : null;
  }
  return rawKey in KEY_TO_CODE ? rawKey : null;
}

// ============================================================================
// recording state suppression
// ============================================================================

let shortcutRecordingActive = false;

/**
 * Set to true when the settings page enters the shortcut capture state. The capture listener and
 * useAppKeyboard are both window capture listeners, but capture registers later (it is only
 * attached on clicking the capture button), and within the same phase the earlier registration runs
 * first — the combination pressed during capture would trigger the original command before reaching
 * the capture handler, so rebinding would never succeed. useAppKeyboard checks this flag and
 * short-circuits before dispatching; the menu channel is notified via
 * platform.setShortcutRecordingActive so main can temporarily drop the menu accelerator (on macOS
 * the system menu would otherwise eat the keystrokes before the renderer sees them).
 */
export function setShortcutRecordingActive(active: boolean): void {
  shortcutRecordingActive = active;
}

export function isShortcutRecordingActive(): boolean {
  return shortcutRecordingActive;
}

// ============================================================================
// Effective table
// ============================================================================

export type EffectiveShortcutBindings = Readonly<Record<ShortcutCommandId, readonly string[]>>;

/**
 * Compute the effective table: the command table's default bindings + user overrides (whole-group
 * replacement). An explicit empty array = the user cleared it to “not set” (the effective table is
 * empty, with no fallback to the defaults — a takeover clears the taken-over command into exactly
 * this state); when every entry is invalid, fall back to the defaults (hand-editing setting.json
 * with invalid entries must not break shortcuts as a whole).
 */
export function resolveEffectiveShortcutBindings(
  overrides?: Record<string, readonly string[]>,
): EffectiveShortcutBindings {
  const effective: Record<ShortcutCommandId, readonly string[]> = {} as Record<
    ShortcutCommandId,
    readonly string[]
  >;
  for (const entry of SHORTCUT_COMMANDS) {
    const override = overrides?.[entry.id];
    if (override === undefined) {
      effective[entry.id] = entry.defaultBindings;
      continue;
    }
    const valid = override.filter((binding) => parseShortcutBinding(binding) !== null);
    if (override.length > 0 && valid.length === 0) {
      logger.warn("[shortcuts] all override bindings invalid, falling back to defaults", {
        commandId: entry.id,
        override,
      });
      effective[entry.id] = entry.defaultBindings;
      continue;
    }
    if (valid.length !== override.length) {
      logger.warn("[shortcuts] ignoring invalid override entries", {
        commandId: entry.id,
        override,
      });
    }
    effective[entry.id] = valid;
  }
  return effective;
}
