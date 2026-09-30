export interface KeyboardShortcutPlatformInfo {
  platform?: string;
  userAgent?: string;
}

interface PrimaryShortcutKeyboardEvent {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

function readNavigatorPlatformInfo(): KeyboardShortcutPlatformInfo {
  if (typeof navigator === "undefined") {
    return {};
  }

  return {
    platform: navigator.platform,
    userAgent: navigator.userAgent,
  };
}

export function isAppleKeyboardPlatform(
  platformInfo: KeyboardShortcutPlatformInfo = readNavigatorPlatformInfo(),
): boolean {
  const platform = platformInfo.platform?.toLowerCase() ?? "";
  const userAgent = platformInfo.userAgent ?? "";

  if (
    platform.includes("mac") ||
    platform.includes("iphone") ||
    platform.includes("ipad") ||
    platform.includes("ipod")
  ) {
    return true;
  }

  return /Mac|iPhone|iPad|iPod/.test(userAgent);
}

function getCommandModifierLabel(platformInfo?: KeyboardShortcutPlatformInfo): string {
  return isAppleKeyboardPlatform(platformInfo) ? "⌘" : "Ctrl";
}

function formatAppleShortcutLabel(...parts: string[]): string {
  return parts.join(" ");
}

export function formatCommandShortcutLabel(
  key: string,
  platformInfo?: KeyboardShortcutPlatformInfo,
): string {
  const mod = getCommandModifierLabel(platformInfo);
  if (isAppleKeyboardPlatform(platformInfo)) {
    return formatAppleShortcutLabel(mod, formatShortcutKeyLabel(key));
  }
  return `${mod}+${key.toUpperCase()}`;
}

function formatShortcutKeyLabel(key: string): string {
  switch (key) {
    case "[":
      return "[";
    case "]":
      return "]";
    default:
      return key.toUpperCase();
  }
}

export function matchesPrimaryShortcut(
  event: PrimaryShortcutKeyboardEvent,
  key: string,
  platformInfo?: KeyboardShortcutPlatformInfo,
): boolean {
  return (
    matchesPrimaryModifier(event, platformInfo) &&
    !event.shiftKey &&
    !event.altKey &&
    matchesShortcutKey(event, key)
  );
}

function matchesPrimaryModifier(
  event: PrimaryShortcutKeyboardEvent,
  platformInfo?: KeyboardShortcutPlatformInfo,
): boolean {
  const isApple = isAppleKeyboardPlatform(platformInfo);
  // Primary shortcut keys should be isolated by platform. macOS's Ctrl is reserved for system Emacs-style text editing,
  // Ctrl is only used in Windows/Linux; pressing Ctrl and Command at the same time is not regarded as the main shortcut key to avoid accidental triggering.
  return isApple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export function matchesCtrlShortcut(event: PrimaryShortcutKeyboardEvent, key: string): boolean {
  return (
    event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.altKey &&
    matchesShortcutKey(event, key)
  );
}

function matchesShortcutKey(
  event: Pick<PrimaryShortcutKeyboardEvent, "key" | "code">,
  key: string,
): boolean {
  const normalizedKey = key.toLowerCase();
  if (event.key.toLowerCase() === normalizedKey) {
    return true;
  }

  // Fix instructions: When pressing Option to participate in key combinations on macOS, event.key may be rewritten into other characters by the current keyboard layout.
  // Pressing the key directly will misjudge shortcut keys such as ⌥⌘B as misses. Add a layer of code matching here to avoid being affected by the input method/layout.
  const expectedCode = getExpectedShortcutCode(normalizedKey);
  return expectedCode != null && event.code === expectedCode;
}

function getExpectedShortcutCode(key: string): string | null {
  if (key.length === 1) {
    const lower = key.toLowerCase();
    if (lower >= "a" && lower <= "z") {
      return `Key${lower.toUpperCase()}`;
    }
    if (lower >= "0" && lower <= "9") {
      return `Digit${lower}`;
    }
  }

  switch (key) {
    case "[":
      return "BracketLeft";
    case "]":
      return "BracketRight";
    default:
      return null;
  }
}
