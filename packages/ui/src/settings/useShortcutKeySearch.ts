import { useCallback, useEffect, useState } from "react";
import { recordShortcutBinding } from "@/shortcuts/bindings.js";

export interface ShortcutKeySearch {
  /** Armed state: waiting for the user to press the key combination. */
  armed: boolean;
  /**
   * The captured combination (null = key filtering not enabled). Exclusive keyboard suppression is
   * managed centrally by the settings page based on the armed state.
   */
  binding: string | null;
  /**
   * Toggles the armed state. Before activating, the caller must first cancel any inline recording
   * (mutually exclusive, see ShortcutSettingsSection).
   */
  toggle: () => void;
  /** Leaves the armed state (the filter for the captured combination is kept). */
  disarm: () => void;
  /** Clears the captured combination (the filter reverts to plain text). */
  clear: () => void;
}

/**
 * State machine for the settings page's "search by key combination" (the same model as the VSCode
 * keyboard shortcuts): Escape leaves the armed state; Backspace clears the captured combination;
 * every other event is captured by the core recorder (including platform normalization), and on
 * success the armed state is left while the filter is kept until it is cleared manually. Keys that
 * can never appear in the command table, such as bare letters (recorder invalid), are silently
 * ignored while waiting for the next valid combination. Filter hits are compared with
 * conflicts.isSamePhysicalBinding (physical equivalence, so win's Ctrl+m ≡ CmdOrCtrl+m), which is
 * the same table that conflict detection sees.
 */
export function useShortcutKeySearch(): ShortcutKeySearch {
  const [armed, setArmed] = useState(false);
  const [binding, setBinding] = useState<string | null>(null);

  useEffect(() => {
    if (!armed) {
      return;
    }
    function handleKeySearchKeydown(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setArmed(false);
        return;
      }
      if (event.key === "Backspace") {
        setBinding(null);
        return;
      }
      const result = recordShortcutBinding(event);
      if (result.kind !== "binding") {
        return;
      }
      setBinding(result.binding);
      setArmed(false);
    }

    window.addEventListener("keydown", handleKeySearchKeydown, true);
    return () => {
      window.removeEventListener("keydown", handleKeySearchKeydown, true);
    };
  }, [armed]);

  const toggle = useCallback(() => setArmed((current) => !current), []);
  const disarm = useCallback(() => setArmed(false), []);
  const clear = useCallback(() => setBinding(null), []);

  return { armed, binding, toggle, disarm, clear };
}
