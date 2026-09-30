import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ShortcutCommandId } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { checkShortcutBindingConflict, isSamePhysicalBinding } from "@/shortcuts/conflicts.js";
import { formatShortcutBindingLabel } from "@/shortcuts/label.js";
import { recordShortcutBinding, type EffectiveShortcutBindings } from "@/shortcuts/bindings.js";
import type { RecordingState } from "./ShortcutBindingRow.js";

interface UseShortcutRecordingOptions {
  recording: RecordingState | null;
  setRecording: Dispatch<SetStateAction<RecordingState | null>>;
  /** The effective binding table (already resolved against overrides by the Section). */
  effective: EffectiveShortcutBindings;
  overrides: Record<string, readonly string[]> | undefined;
  isDesktop: boolean;
  /** Backspace while recording: restore the default (the Section's pre-check logic). */
  clearBinding: (commandId: ShortcutCommandId) => void;
  appendBinding: (commandId: ShortcutCommandId, binding: string) => void;
  replaceBindingAt: (commandId: ShortcutCommandId, bindingIndex: number, binding: string) => void;
}

/**
 * Keyboard capture while recording: window keydown capture. Escape cancels; Backspace restores the
 * default; everything else goes to the core recorder. Persisting is dispatched by
 * RecordingState.mode: add → append one entry; replace → replace the entry that bindingIndex points
 * at (null = the placeholder row for an unassigned command, recording the first one, which is
 * equivalent to appending). A physical duplicate of the same command is rejected in red at the
 * recording entry (add compares against all entries, replace skips the target entry).
 */
export function useShortcutRecording({
  recording,
  setRecording,
  effective,
  overrides,
  isDesktop,
  clearBinding,
  appendBinding,
  replaceBindingAt,
}: UseShortcutRecordingOptions): void {
  const { intl } = useZCodeIntl();

  useEffect(() => {
    if (!recording) {
      return;
    }
    function handleRecordingKeydown(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();

      setRecording((current) => {
        if (!current) {
          return current;
        }
        if (event.key === "Escape") {
          return null;
        }
        if (event.key === "Backspace") {
          clearBinding(current.commandId);
          return null;
        }

        const result = recordShortcutBinding(event);
        if (result.kind === "pending") {
          // Residual conflict/invalid prompts can lead to the impression that the recorder is not listening for new keystrokes - modifier keys are cleared as soon as they are pressed,
          // Ensure that "re-press the second combination directly after the conflict" is visually alive (actually it is always listening).
          if (
            current.preview === null &&
            current.error === null &&
            current.conflictBinding === null
          ) {
            return current;
          }
          return { ...current, preview: null, error: null, conflictBinding: null };
        }
        if (result.kind === "invalid") {
          return {
            ...current,
            preview: null,
            conflictBinding: null,
            error: intl.formatMessage({
              id:
                result.reason === "no-modifier"
                  ? "settings.shortcuts.invalidNoModifier"
                  : "settings.shortcuts.invalidKey",
            }),
          };
        }

        // The physical equivalent of the same command is repeated: add is compared to all valid entries; replace skips the one being replaced.
        // Goal bar. It makes no sense to hang the same set of keys with one command, so it will be marked red and rejected.
        const sameCommandBindings = effective[current.commandId] ?? [];
        const duplicate = sameCommandBindings.some((binding, index) =>
          current.mode === "replace" && index === current.bindingIndex
            ? false
            : isSamePhysicalBinding(binding, result.binding),
        );
        if (duplicate) {
          return {
            ...current,
            preview: formatShortcutBindingLabel(result.binding),
            conflictBinding: null,
            error: intl.formatMessage({ id: "settings.shortcuts.duplicateBinding" }),
          };
        }

        // The menu channel command on the web side cannot be configured, but the default key is still monitored and consumed by root-level fallback. Press the reserved key to refuse to bind.
        const conflict = checkShortcutBindingConflict(
          current.commandId,
          result.binding,
          overrides,
          {
            menuChannelReserved: !isDesktop,
          },
        );
        if (conflict) {
          return {
            ...current,
            preview: formatShortcutBindingLabel(result.binding),
            // The system reserved key is directly rejected (no confirmation entry); the command occupation in the app prompts the occupier and supports secondary confirmation to grab the binding.
            conflictBinding: conflict.kind === "occupied" ? result.binding : null,
            error:
              conflict.kind === "reserved"
                ? intl.formatMessage({ id: "settings.shortcuts.conflictReserved" })
                : intl.formatMessage(
                    { id: "settings.shortcuts.conflictOccupied" },
                    {
                      command:
                        conflict.ownerCommandId !== undefined
                          ? intl.formatMessage({
                              id: `settings.shortcuts.command.${conflict.ownerCommandId}`,
                            })
                          : "",
                    },
                  ),
          };
        }

        if (current.mode === "add" || current.bindingIndex === null) {
          appendBinding(current.commandId, result.binding);
        } else {
          replaceBindingAt(current.commandId, current.bindingIndex, result.binding);
        }
        return null;
      });
    }

    window.addEventListener("keydown", handleRecordingKeydown, true);
    return () => {
      window.removeEventListener("keydown", handleRecordingKeydown, true);
    };
  }, [
    appendBinding,
    clearBinding,
    effective,
    intl,
    isDesktop,
    overrides,
    recording,
    replaceBindingAt,
    setRecording,
  ]);
}
