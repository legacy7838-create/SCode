/**
 * composer-scope shortcut resolution — a standalone module whose only consumer is the
 * keyboard-behaviour plugin of LexicalChatInput; useAppKeyboard / menus / the Web fallback listener
 * are wholly unaware of composer commands. It depends only on the core matcher, not on DOM / React,
 * so it can be unit-tested on its own.
 */
import type { ShortcutBindingEvent } from "./bindings.js";
import { matchesShortcutBinding } from "./bindings.js";

/**
 * The slice of composer-scope commands in the active binding table (only these two matter, which
 * avoids the type dependency of pulling in the whole table).
 */
interface ComposerEffectiveBindings {
  readonly composerSend: readonly string[];
  readonly composerInsertNewline: readonly string[];
}

/** The final action of an Enter-family event inside the composer. */
type ComposerKeyAction = "send" | "newline";

/**
 * Resolve a composer action against the active binding table (the rebinding layer, with one uniform
 * openness policy).
 *
 * It matches against all active bindings of `composerInsertNewline` / `composerSend` (newline is
 * checked first: a mistaken send while editing costs more) — and it is **not restricted to the
 * Enter family**: the user can bind send to any key such as F9, consistent with the openness policy
 * of the other commands; on a hit it returns the action, and when nothing matches it returns null
 * (the caller follows its existing main chain).
 *
 * The runtime gates on the send action (submitDisabled / enterSubmits on phone viewports / empty
 * input / yielding to reversed delivery) are executed by the caller; this function only answers the
 * part that "the key table gets to decide".
 */
export function resolveComposerKeyAction(
  event: Pick<ShortcutBindingEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  effective: ComposerEffectiveBindings,
  platformInfo?: { platform?: string; userAgent?: string },
): ComposerKeyAction | null {
  for (const binding of effective.composerInsertNewline ?? []) {
    if (matchesShortcutBinding(event, binding, platformInfo)) {
      return "newline";
    }
  }
  for (const binding of effective.composerSend ?? []) {
    if (matchesShortcutBinding(event, binding, platformInfo)) {
      return "send";
    }
  }
  return null;
}

/**
 * Whether a bare Enter should fall back to a newline (a pre-check on the main chain): once the user
 * has rebound `composerSend` away (the active bindings no longer include a bare Enter, an explicit
 * empty array included = unset), bare Enter no longer means send, so Lexical's newline is allowed
 * through — the expected behavior for the "Ctrl+Enter camp" after rebinding.
 */
export function shouldBareEnterFallThroughToNewline(effective: ComposerEffectiveBindings): boolean {
  return !effective.composerSend.includes("Enter");
}
