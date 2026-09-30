import { useEffect, useRef } from "react";
import { SHORTCUT_COMMANDS, type ShortcutCommandId } from "@zcode/shared";
import {
  isEditableShortcutEventTarget,
  isShiftOnlyPrintableBinding,
  isShortcutRecordingActive,
  matchesShortcutBinding,
} from "@/shortcuts/bindings.js";
import { useEffectiveShortcutBindings } from "@/shortcuts/useShortcutBindings.js";

/**
 * Handler table for the window channel's shortcuts: command ID → callback; null/missing means the
 * command is currently unavailable.
 */
type AppKeyboardHandlers = Partial<Record<ShortcutCommandId, (() => void) | null>>;

/**
 * A thin shell for global keyboard dispatch: window keydown capture → the shortcuts kernel's
 * generic matching → the command handler.
 *
 * - All key knowledge lives in the shortcuts kernel (active map + matchers); this hook knows no
 *   specific key;
 * - when the handler is null/missing, preventDefault is not called (with the feature unavailable
 *   the browser's default behavior is let through, e.g. history navigation);
 * - interaction note: intercepting during the capture phase guarantees that the browser or the
 *   desktop shell's default behavior cannot take over when focus sits in an ordinary page region;
 * - the listener is attached once, and the handlers / active map are passed through a ref — after
 *   the settings page remaps a key, the very next keypress already dispatches with the new binding.
 */
export function useAppKeyboard(handlers: AppKeyboardHandlers) {
  const effective = useEffectiveShortcutBindings();
  const stateRef = useRef({ handlers, effective });
  stateRef.current = { handlers, effective };

  useEffect(() => {
    function handleWindowKeydown(event: KeyboardEvent) {
      if (event.repeat || event.isComposing) {
        return;
      }
      // Recording state short-circuit: the recording monitor is registered later than this monitor (registration first, execution first in the same stage), if there is no short-circuit
      // Recording the pressed combination will trigger the original command first, and changing the key will never succeed (see the setShortcutRecordingActive comment).
      if (isShortcutRecordingActive()) {
        return;
      }

      const { handlers: currentHandlers, effective: currentEffective } = stateRef.current;
      // A pure Shift+printable keybinding (such as Shift+f) is the same physical event as "typing a capital letter".
      // This type of binding is skipped when the focus is on an editable element (chat input box/search box/terminal), otherwise the user cannot type the corresponding capital letters.
      const editableTarget = isEditableShortcutEventTarget(event.target);
      for (const entry of SHORTCUT_COMMANDS) {
        if (entry.channel !== "window") {
          continue;
        }
        // Composer scope commands are consumed by the Lexical plug-in of the input box and are distributed globally with zero awareness.
        if (entry.scope === "composer") {
          continue;
        }
        const handler = currentHandlers[entry.id];
        if (!handler) {
          continue;
        }
        const bindings = currentEffective[entry.id];
        if (!bindings || bindings.length === 0) {
          continue;
        }
        for (const binding of bindings) {
          if (editableTarget && isShiftOnlyPrintableBinding(binding)) {
            continue;
          }
          if (matchesShortcutBinding(event, binding)) {
            event.preventDefault();
            handler();
            return;
          }
        }
      }
    }

    window.addEventListener("keydown", handleWindowKeydown, true);
    return () => {
      window.removeEventListener("keydown", handleWindowKeydown, true);
    };
  }, []);
}
