/**
 * The shortcut command table and binding serialization format — the single source of truth for
 * shortcuts across the whole repo.
 *
 * Design constraints:
 * - This file holds pure data + pure functions only, with no DOM / Electron dependency, so renderer / main / services can share it;
 * - One and the same binding string is used for setting.json persistence, renderer matching, and pass-through to Electron menu accelerators;
 * - Key knowledge may only converge here; consumers (useAppKeyboard, the settings page, menus) must not parse keys themselves.
 */

/** Dispatch channel of a shortcut command: window = renderer keyboard dispatch (identical on all three ends); menu = desktop app menu accelerator. */
export type ShortcutChannel = "window" | "menu";

/** IDs of commands that have a configurable shortcut; one-to-one with SHORTCUT_COMMANDS. */
export type ShortcutCommandId =
  | "toggleInterfaceMode"
  | "openOnboarding"
  | "openCommandCenter"
  | "openSettings"
  | "findInTask"
  | "toggleSidebar"
  | "switchTheme"
  | "toggleTerminal"
  | "toggleSidePane"
  | "previousConversation"
  | "nextConversation"
  | "navigateBack"
  | "navigateForward"
  | "openModelMenu"
  | "cycleSessionMode"
  | "cycleThoughtLevel"
  | "newTask"
  | "openWorkspace"
  | "closeActiveContext"
  | "zoomIn"
  | "zoomOut"
  | "resetZoom"
  | "composerSend"
  | "composerInsertNewline";

/**
 * Command scope: global = dispatched globally (useAppKeyboard / menu accelerator);
 * composer = consumed by the Lexical keyboard-behaviour plugin while the chat input box is focused,
 * and completely invisible to every other dispatcher.
 * That is why the Enter family can safely be listed here — the blast radius stays inside the input box.
 */
export type ShortcutScope = "global" | "composer";

export interface ShortcutCommandEntry {
  readonly id: ShortcutCommandId;
  readonly channel: ShortcutChannel;
  /** Scope; defaults to global. */
  readonly scope?: ShortcutScope;
  /** Default bindings as canonical serialized strings; several entries mean two defaults (an override replaces the whole group). */
  readonly defaultBindings: readonly string[];
}

/**
 * The command table: the single source of truth for shortcut commands.
 * Note: navigateBack/navigateForward are history back/forward; previousConversation/nextConversation
 * are the "previous/next task" (an early prototype once mislabelled the two — this table wins).
 */
export const SHORTCUT_COMMANDS: readonly ShortcutCommandEntry[] = [
  {
    id: "openCommandCenter",
    channel: "window",
    defaultBindings: ["CmdOrCtrl+k", "CmdOrCtrl+Shift+p"],
  },
  // Open the settings page: mac ⌘, / win·linux Ctrl+, (system convention, such as macOS Settings..., VSCode)
  { id: "openSettings", channel: "window", defaultBindings: ["CmdOrCtrl+,"] },
  { id: "findInTask", channel: "window", defaultBindings: ["CmdOrCtrl+f"] },
  { id: "toggleSidebar", channel: "window", defaultBindings: ["CmdOrCtrl+b"] },
  { id: "switchTheme", channel: "window", defaultBindings: ["CmdOrCtrl+Shift+l"] },
  { id: "toggleTerminal", channel: "window", defaultBindings: ["CmdOrCtrl+j"] },
  { id: "toggleSidePane", channel: "window", defaultBindings: ["CmdOrCtrl+Alt+b"] },
  { id: "previousConversation", channel: "window", defaultBindings: ["CmdOrCtrl+Shift+["] },
  { id: "nextConversation", channel: "window", defaultBindings: ["CmdOrCtrl+Shift+]"] },
  { id: "navigateBack", channel: "window", defaultBindings: ["CmdOrCtrl+["] },
  { id: "navigateForward", channel: "window", defaultBindings: ["CmdOrCtrl+]"] },
  // Composer toolbar action (original fixed hotkey converted to normal): explicit Ctrl modification (also Ctrl on mac,
  // Consistent with the semantics of the old matchesCtrlShortcut), it is monitored by the window capture of the toolbar and consumed according to the effective table.
  { id: "openModelMenu", channel: "window", defaultBindings: ["Ctrl+m"] },
  { id: "cycleSessionMode", channel: "window", defaultBindings: ["Ctrl+Shift+m"] },
  { id: "cycleThoughtLevel", channel: "window", defaultBindings: ["Ctrl+t"] },
  { id: "newTask", channel: "menu", defaultBindings: ["CmdOrCtrl+n"] },
  { id: "openWorkspace", channel: "menu", defaultBindings: ["CmdOrCtrl+o"] },
  { id: "closeActiveContext", channel: "menu", defaultBindings: ["CmdOrCtrl+w"] },
  { id: "zoomIn", channel: "menu", defaultBindings: ["CmdOrCtrl+="] },
  { id: "zoomOut", channel: "menu", defaultBindings: ["CmdOrCtrl+-"] },
  { id: "resetZoom", channel: "menu", defaultBindings: ["CmdOrCtrl+0"] },
  // Composer scope: consumed by the input box Lexical plug-in and does not enter the useAppKeyboard / menu.
  // The channel is only used as a type holder (rendering process behavior), and the distributor is identified by scope.
  { id: "composerSend", channel: "window", scope: "composer", defaultBindings: ["Enter"] },
  {
    id: "composerInsertNewline",
    channel: "window",
    scope: "composer",
    defaultBindings: ["Shift+Enter"],
  },
  { id: "toggleInterfaceMode", channel: "window", defaultBindings: ["CmdOrCtrl+Shift+u"] },
  { id: "openOnboarding", channel: "window", defaultBindings: ["CmdOrCtrl+Shift+o"] },
];

/** Default bindings by command ID; an unknown command returns an empty array (the effective table's resolve ignores unknown commands entirely). */
export function getDefaultShortcutBindings(id: string): readonly string[] {
  return SHORTCUT_COMMANDS.find((entry) => entry.id === id)?.defaultBindings ?? [];
}

// ============================================================================
// Binding serialization format (Electron accelerator compatible subset)
// ============================================================================

/** A parsed binding: four modifier switches + a canonical key name. */
export interface ParsedShortcutBinding {
  cmdOrCtrl: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  altGr: boolean;
  /** Canonical key name: lowercase letters / digits / symbol characters (= - [ ] , . / ; ' ` \) / named keys (F1..F12, ArrowUp…). */
  key: string;
}

/** The fixed modifier order used when serializing. */
const MODIFIER_ORDER = [
  ["CmdOrCtrl", "cmdOrCtrl"],
  ["Ctrl", "ctrl"],
  ["Alt", "alt"],
  ["Shift", "shift"],
  ["AltGr", "altGr"],
] as const satisfies ReadonlyArray<readonly [string, keyof ParsedShortcutBinding]>;

/** Menu-compatibility alias normalization: Plus/Equal → "=", Minus → "-". */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  Plus: "=",
  Equal: "=",
  Minus: "-",
};

/** Single-character keys: lowercase letters, digits and symbols. Uppercase letters are invalid (recording/serializing lowercases uniformly). */
const SINGLE_CHAR_KEY = /^[a-z0-9[\]=\-,./;'\\`]$/;

/** Named key allowlist (case-sensitive). Enter is for composer-scoped commands. */
const NAMED_KEYS: ReadonlySet<string> = new Set([
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Delete",
  "Insert",
  "Enter",
]);

/** Key name normalization: returns the canonical key name when valid, null when invalid. */
export function normalizeShortcutKey(rawKey: string): string | null {
  const aliased = KEY_ALIASES[rawKey] ?? rawKey;
  if (SINGLE_CHAR_KEY.test(aliased)) {
    return aliased;
  }
  return NAMED_KEYS.has(aliased) ? aliased : null;
}

/**
 * Parses a binding string. Lenient: modifier order is not significant ("Shift+CmdOrCtrl+p" parses);
 * strict: the key name must be canonical (uppercase letters, a bare "+", and unknown named keys are
 * all invalid), and a repeated modifier is invalid.
 */
export function parseShortcutBinding(binding: string): ParsedShortcutBinding | null {
  const tokens = binding.split("+");
  // The last bit must be a key; "+" itself is not a legal key (use "=" or the alias Plus), and split produces an empty token, which is illegal.
  const keyToken = tokens[tokens.length - 1];
  if (keyToken === undefined || keyToken === "") {
    return null;
  }

  const parsed: ParsedShortcutBinding = {
    cmdOrCtrl: false,
    ctrl: false,
    alt: false,
    shift: false,
    altGr: false,
    key: "",
  };

  for (const token of tokens.slice(0, -1)) {
    const modifier = MODIFIER_ORDER.find(([name]) => name === token);
    if (!modifier || parsed[modifier[1]]) {
      // Unknown modifier keys (including Electron modified names such as Meta/Command) or repeated modifier keys are illegal.
      return null;
    }
    parsed[modifier[1]] = true;
  }

  const key = normalizeShortcutKey(keyToken);
  if (key === null) {
    return null;
  }
  parsed.key = key;
  return parsed;
}

/** Serializes to canonical form (modifiers in the fixed order + canonical key name); returns null if any part is invalid. */
export function serializeShortcutBinding(parsed: ParsedShortcutBinding): string | null {
  const key = normalizeShortcutKey(parsed.key);
  if (key === null) {
    return null;
  }

  const parts: string[] = [];
  for (const [name, field] of MODIFIER_ORDER) {
    if (parsed[field]) {
      parts.push(name);
    }
  }
  parts.push(key);
  return parts.join("+");
}

/** Whether a binding string is a valid canonical form (parsing then re-serializing reproduces the original string). */
export function isValidShortcutBinding(binding: string): boolean {
  const parsed = parseShortcutBinding(binding);
  return parsed !== null && serializeShortcutBinding(parsed) === binding;
}
