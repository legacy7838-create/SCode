/**
 * Shortcut conflict policy—reserved-key blacklist, physical-equivalence normalization, occupancy
 * detection, and confirmed re-binding after a second confirmation.
 *
 * Split out of bindings.ts (layering the kernel against the conflict policy, and bindings.ts is
 * under a max-lines gate): key matching / recording / the effective table stay in bindings.ts, and
 * this module only answers “can this binding take effect?”.
 */
import { parseShortcutBinding, SHORTCUT_COMMANDS, type ShortcutCommandId } from "@zcode/shared";

import {
  isAppleKeyboardPlatform,
  type KeyboardShortcutPlatformInfo,
} from "../lib/keyboardShortcuts.js";
import { resolveEffectiveShortcutBindings } from "./bindings.js";

/**
 * Reserved-key blacklist: native browser/editor behavior, reload and devtools, the whole function
 * key range, and single keys fixed to component interactions. Comparison happens after
 * normalization (canonical keys, see checkShortcutBindingConflict); the command table's default
 * bindings must not intersect it (asserted by unit tests, for the global scope only). Note: of
 * Escape/Enter/Tab/Space/Backspace, Enter is already on the key-name whitelist (the composer scope
 * needs it) and is listed explicitly in the blacklist to block the global scope;
 * Escape/Tab/Space/Backspace are still not on the key-name whitelist.
 */
const RESERVED_BINDINGS: ReadonlySet<string> = new Set([
  // Edit class native behavior (primary modifier key combination)
  ...["c", "v", "x", "z", "a", "y", "s", "p", "l"].map((key) => `CmdOrCtrl+${key}`),
  "CmdOrCtrl+Shift+z",
  // Refresh and development tools
  "CmdOrCtrl+r",
  "CmdOrCtrl+Shift+r",
  "CmdOrCtrl+Shift+i",
  "CmdOrCtrl+Shift+j",
  "CmdOrCtrl+Shift+c",
  // The entire section of function keys (any modified combination of F1-F12)
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
  ...Array.from({ length: 12 }, (_, index) => `CmdOrCtrl+F${index + 1}`),
  ...Array.from({ length: 12 }, (_, index) => `CmdOrCtrl+Shift+F${index + 1}`),
  // Arrow key single key (component fixed interaction)
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  // Enter: After the key name whitelist is released, the global scope must be explicitly blocked
  // (Globalizing the dialog box confirmation key will destroy all confirmation interactions); composer scope is not restricted by this.
  "Enter",
]);

/**
 * The fixed accelerator ⌘M of the macOS system menu role:"minimize" (new scenario B): the system
 * menu consumes the key before the renderer, so binding to it is a dead binding that no command in
 * any scope may occupy or re-bind. It only takes effect on mac—on win/linux CmdOrCtrl+m is
 * physically equivalent to Ctrl+M (openModelMenu's default key), which goes through occupancy
 * detection instead of a reserved-key block. After the three toolbar keys were promoted, this is
 * the only mac defense for CmdOrCtrl+m.
 */
const MACOS_MENU_RESERVED_BINDINGS: ReadonlySet<string> = new Set(["CmdOrCtrl+m"]);

/**
 * Physical-equivalence normalization dedicated to conflict detection (new): the matching side
 * treats platform-equivalent combinations as the same physical key (on win/linux CmdOrCtrl ≡
 * explicit Ctrl, and AltGr carries the Alt bit). If conflict detection only did exact string
 * comparison, the recorder's platform-normalized output (e.g. recording ⌃M on win yields
 * "CmdOrCtrl+m") would slip past the occupancy check against explicit Ctrl default bindings (the
 * three toolbar keys such as "Ctrl+m"), causing silent shadowing with no notice. Normalization
 * converts them into stable comparison keys following the semantics of the kernel's modifiersMatch:
 * - non-apple: primary = cmdOrCtrl | ctrl | altGr (the same physical primary modifier), alt = alt |
 *   altGr
 * - apple: primary = cmdOrCtrl (meta), secondaryCtrl = ctrl (an independent physical key), alt =
 *   alt | altGr
 */
function canonicalBindingKey(binding: string, isApple: boolean): string | null {
  const parsed = parseShortcutBinding(binding);
  if (parsed === null) {
    return null;
  }
  if (isApple) {
    // wantPrimaryOrCtrl of modifiersMatch on apple also counts altGr as the primary modifier
    // (AltGr+m ≡ ⌘⌥M ≡ CmdOrCtrl+Alt+m), the canonical main modification bit must be converted together.
    return `${parsed.cmdOrCtrl || parsed.altGr ? 1 : 0}${parsed.ctrl ? 1 : 0}${
      parsed.alt || parsed.altGr ? 1 : 0
    }${parsed.shift ? 1 : 0}:${parsed.key}`;
  }
  return `${parsed.cmdOrCtrl || parsed.ctrl || parsed.altGr ? 1 : 0}${
    parsed.alt || parsed.altGr ? 1 : 0
  }${parsed.shift ? 1 : 0}:${parsed.key}`;
}

/**
 * Whether two binding strings are the same physical combination (equal canonical keys): the
 * normalization used by conflict detection is reused for search, and the settings page's “search by
 * key combination” uses it to match a CmdOrCtrl+m recorded on win with an explicit Ctrl+m as the
 * same entry. If either string fails to parse, they are not equal (consistent with conflict
 * detection's null short-circuit semantics).
 */
export function isSamePhysicalBinding(
  a: string,
  b: string,
  options?: { platformInfo?: KeyboardShortcutPlatformInfo },
): boolean {
  const isApple = isAppleKeyboardPlatform(options?.platformInfo);
  const keyA = canonicalBindingKey(a, isApple);
  const keyB = canonicalBindingKey(b, isApple);
  return keyA !== null && keyA === keyB;
}

/**
 * The canonical comparison keys of the reserved-key blacklist (built lazily per platform;
 * canonicalization also blocks equivalent variants hand-edited into setting.json).
 */
let reservedCanonicalKeysCache: {
  apple: ReadonlySet<string>;
  nonApple: ReadonlySet<string>;
} | null = null;
function getReservedCanonicalKeys(): {
  apple: ReadonlySet<string>;
  nonApple: ReadonlySet<string>;
} {
  if (reservedCanonicalKeysCache === null) {
    const apple = new Set<string>();
    const nonApple = new Set<string>();
    for (const binding of RESERVED_BINDINGS) {
      const appleKey = canonicalBindingKey(binding, true);
      if (appleKey !== null) {
        apple.add(appleKey);
      }
      const nonAppleKey = canonicalBindingKey(binding, false);
      if (nonAppleKey !== null) {
        nonApple.add(nonAppleKey);
      }
    }
    reservedCanonicalKeysCache = { apple, nonApple };
  }
  return reservedCanonicalKeysCache;
}

interface ShortcutBindingConflict {
  kind: "reserved" | "occupied";
  /** The occupying command when the result is occupied. */
  ownerCommandId?: ShortcutCommandId;
  binding: string;
}

/**
 * Conflict detection (rejection + red-marking policy): whether binding newBinding to commandId
 * would be rejected. Returning null means the binding is allowed. commandId's own existing binding
 * is not a conflict (the override semantics are whole-set replacement). Scope isolation: occupancy
 * is only compared against commands in the **same scope** (the composer's CmdOrCtrl+Enter
 * coexisting with a global command is not a conflict); the reserved blacklist only blocks
 * re-bindings in the global scope. Physical-equivalence normalization (new): both the blacklist and
 * the occupancy comparison run on canonical keys, so platform-equivalent combinations (CmdOrCtrl ≡
 * Ctrl on win/linux) are not missed.
 */
export function checkShortcutBindingConflict(
  commandId: ShortcutCommandId,
  newBinding: string,
  overrides?: Record<string, readonly string[]>,
  options?: {
    menuChannelReserved?: boolean;
    /**
     * Defaults to the runtime navigator (unit tests pass one in explicitly to pin the platform
     * semantics).
     */
    platformInfo?: KeyboardShortcutPlatformInfo;
  },
): ShortcutBindingConflict | null {
  const commandEntry = SHORTCUT_COMMANDS.find((entry) => entry.id === commandId);
  const commandScope = commandEntry?.scope ?? "global";
  const isApple = isAppleKeyboardPlatform(options?.platformInfo);
  const newKey = canonicalBindingKey(newBinding, isApple);
  // The macOS ⌘M minimize line of defense has nothing to do with scope: the system menu is dispatched before any renderer,
  // Binding to the composer command is also a dead binding.
  if (isApple && MACOS_MENU_RESERVED_BINDINGS.has(newBinding)) {
    return { kind: "reserved", binding: newBinding };
  }
  if (commandScope === "global") {
    if (newKey !== null && getReservedCanonicalKeys()[isApple ? "apple" : "nonApple"].has(newKey)) {
      return { kind: "reserved", binding: newBinding };
    }
  }
  const effective = resolveEffectiveShortcutBindings(overrides);
  for (const entry of SHORTCUT_COMMANDS) {
    if (entry.id === commandId) {
      continue;
    }
    // Scope isolation: the same key across scopes does not conflict
    if ((entry.scope ?? "global") !== commandScope) {
      continue;
    }
    for (const binding of effective[entry.id] ?? []) {
      const candidateKey = canonicalBindingKey(binding, isApple);
      if (newKey !== null && candidateKey === newKey) {
        // The menu channel command on the web side is not configurable, but its default key is still monitored by root-level fallback
        // (useRootPlatformEffects fixed response Cmd/Ctrl+N, O) consumption - press the reserve key to reject,
        // There is no entrance for grabbing and tying, otherwise the same button will perform double actions after grabbing and tying.
        if (options?.menuChannelReserved && entry.channel === "menu") {
          return { kind: "reserved", binding: newBinding };
        }
        return { kind: "occupied", ownerCommandId: entry.id, binding: newBinding };
      }
    }
  }
  return null;
}

/**
 * Re-binding after the second confirmation (an in-app command may take over an occupied binding
 * once it is confirmed): bind newBinding to commandId with row-level semantics, and remove it from
 * the effective table of whichever other command currently occupies that binding—the taken-over
 * command gets overrides = its effective bindings minus newBinding, which may be an explicit empty
 * array (= not set, no fallback to the default). Physical-equivalence normalization (new):
 * platform-equivalent entries (e.g. Ctrl+m and CmdOrCtrl+m on win) are cleared as well. Row-level
 * semantics: re-binding only changes “how the conflict is handled”, not the row-level action the
 * user originally chose—options.mode/bindingIndex behave as in the recorder: replace + an index →
 * replace that entry (the remaining bindings are kept); add, or a null bindingIndex (nothing
 * assigned yet, recording the first one) → append; the default (older callers) → replace the whole
 * set with the single key.
 */
export function buildShortcutOverridesAfterSteal(
  overrides: Record<string, readonly string[]> | undefined,
  commandId: ShortcutCommandId,
  newBinding: string,
  options?: {
    platformInfo?: KeyboardShortcutPlatformInfo;
    /**
     * Recording mode (from the settings page's RecordingState): replace = row-level replacement,
     * add = append; the default = whole-set replacement.
     */
    mode?: "replace" | "add";
    /** The target index in replace mode. */
    bindingIndex?: number | null;
  },
): Record<string, string[]> {
  const isApple = isAppleKeyboardPlatform(options?.platformInfo);
  const newKey = canonicalBindingKey(newBinding, isApple);
  const effective = resolveEffectiveShortcutBindings(overrides);
  const commandEntry = SHORTCUT_COMMANDS.find((entry) => entry.id === commandId);
  const commandScope = commandEntry?.scope ?? "global";
  const next: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(overrides ?? {})) {
    next[key] = [...value];
  }
  const currentBindings = effective[commandId] ?? [];
  if (options?.mode === "replace" && options.bindingIndex != null) {
    const target = options.bindingIndex;
    next[commandId] = currentBindings.map((binding, index) =>
      index === target ? newBinding : binding,
    );
  } else if (options?.mode === "add" || options?.bindingIndex === null) {
    next[commandId] = [...currentBindings, newBinding];
  } else {
    next[commandId] = [newBinding];
  }
  for (const entry of SHORTCUT_COMMANDS) {
    if (entry.id === commandId) {
      continue;
    }
    // Scope isolation: grab binding only clears the occupation of commands in the same scope
    if ((entry.scope ?? "global") !== commandScope) {
      continue;
    }
    const remaining = (effective[entry.id] ?? []).filter((binding) => {
      const candidateKey = canonicalBindingKey(binding, isApple);
      return newKey === null || candidateKey !== newKey;
    });
    if (remaining.length !== (effective[entry.id] ?? []).length) {
      next[entry.id] = remaining;
    }
  }
  return next;
}

/**
 * “Add a binding” (one command can hang off several key sets, shown as A / B): append newBinding
 * after the command's existing effective bindings (default keys included). The override semantics
 * are whole-set replacement, so appending must write the complete list of default + existing
 * overrides into overrides, otherwise the default keys that were not overridden would be lost.
 * Physical-equivalent duplicates within the same command are rejected up front by the caller (the
 * settings page's recording entry point); this function does not re-validate them.
 */
export function buildShortcutOverridesAfterAppend(
  overrides: Record<string, readonly string[]> | undefined,
  commandId: ShortcutCommandId,
  newBinding: string,
): Record<string, string[]> {
  const effective = resolveEffectiveShortcutBindings(overrides);
  const next: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(overrides ?? {})) {
    next[key] = [...value];
  }
  next[commandId] = [...(effective[commandId] ?? []), newBinding];
  return next;
}

/**
 * Split-row replacement: swap the bindingIndex-th entry of the effective list for newBinding, then
 * write the whole set back into overrides.
 */
export function buildShortcutOverridesWithBindingAt(
  overrides: Record<string, readonly string[]> | undefined,
  commandId: ShortcutCommandId,
  bindingIndex: number,
  newBinding: string,
): Record<string, string[]> {
  const effective = resolveEffectiveShortcutBindings(overrides);
  const next: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(overrides ?? {})) {
    next[key] = [...value];
  }
  next[commandId] = (effective[commandId] ?? []).map((binding, index) =>
    index === bindingIndex ? newBinding : binding,
  );
  return next;
}
