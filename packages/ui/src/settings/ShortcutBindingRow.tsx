import { Keyboard, Pencil, Trash2 } from "lucide-react";
import type { ShortcutCommandEntry, ShortcutCommandId } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Kbd, KbdGroup } from "@/components/ui/kbd.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatShortcutBindingLabelParts } from "@/shortcuts/label.js";

export interface RecordingState {
  commandId: ShortcutCommandId;
  /**
   * Recording mode: replace = replace a binding (bindingIndex points at an existing entry, null =
   * record the first one when unassigned); add = append a binding to a command.
   */
  mode: "replace" | "add";
  /** Target index in replace mode; null in add mode. */
  bindingIndex: number | null;
  /** Live preview label while recording; null means there is no complete combination yet. */
  preview: string | null;
  /** Conflict / invalid notice (copy after i18n), shown in red. */
  error: string | null;
  /**
   * The pending binding when another app command already holds it; after a second "bind anyway"
   * confirmation it takes the binding anyway (system-reserved keys get no confirmation entry).
   */
  conflictBinding: string | null;
}

interface ShortcutBindingRowProps {
  entry: ShortcutCommandEntry;
  /** Command name after i18n (formatted centrally by the main component and passed in). */
  commandLabel: string;
  bindings: readonly string[];
  /**
   * Whether the command has a user override entry (when true, the keycap marks the customization in
   * the brand color).
   */
  isOverridden: boolean;
  isRecording: boolean;
  recording: RecordingState | null;
  /**
   * Web-side menu-channel command: the recording entry is greyed out (the default key is
   * permanently consumed by the root-level fallback listener).
   */
  menuChannelUnavailable: boolean;
  /**
   * Replaces a binding (index = index in the effective list; null = record the first one when
   * unassigned).
   */
  onRecord: (bindingIndex: number | null) => void;
  onSteal: (binding: string) => void;
  /** Clearing all bindings = unassigned (an explicit empty array, no fallback to defaults). */
  onClearAll: () => void;
}

/**
 * The command row in the shortcut settings page: the command name in the left column is vertically
 * centered across all of its bindings, and the right column is that command's binding list — one
 * row per binding: per-key keycaps + a pencil (clicking it records a replacement for that entry);
 * while recording, it nests in the position of the corresponding entry. Adding/removing bindings is
 * not supported yet (replacement only), so the action column is a "clear all" trash can.
 */
export function ShortcutBindingRow({
  entry,
  commandLabel,
  bindings,
  isOverridden,
  isRecording,
  recording,
  menuChannelUnavailable,
  onRecord,
  onSteal,
  onClearAll,
}: ShortcutBindingRowProps) {
  const { intl } = useZCodeIntl();
  const conflictBinding = isRecording ? recording?.conflictBinding : null;

  // Record inline block: Appears at the position of the replaced item/appended item (preview kbd seizes focus)
  function renderRecorder() {
    return (
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex items-center gap-2">
          <Keyboard className="size-4 text-foreground-subtle" />
          <kbd
            ref={(el) => {
              // Seize focus as soon as recording starts: pull the focus out of editable elements (such as the search box above),
              // Otherwise, the Chinese IME will swallow Shift+letters into a combined input, and the recorder will only receive
              // isComposing/229 noise event, it seems that "Shift combination cannot be recognized".
              el?.focus();
            }}
            tabIndex={-1}
            className="w-fit rounded-md bg-surface px-2 py-1 font-mono text-ui-sm outline-none"
          >
            {recording?.preview ?? intl.formatMessage({ id: "settings.shortcuts.recording" })}
          </kbd>
        </span>
        {recording?.error ? (
          <span
            className="text-ui-sm text-destructive"
            data-testid={`settings-shortcut-error-${entry.id}`}
          >
            {recording.error}
          </span>
        ) : (
          <span className="text-ui-xs text-foreground-subtlest">
            {intl.formatMessage({ id: "settings.shortcuts.recordingHint" })}
          </span>
        )}
        {conflictBinding ? (
          <Button
            variant="outline"
            size="xs"
            className="w-fit"
            data-testid={`settings-shortcut-steal-${entry.id}`}
            onClick={() => onSteal(conflictBinding)}
          >
            {intl.formatMessage({ id: "settings.shortcuts.stealConfirm" })}
          </Button>
        ) : null}
      </span>
    );
  }

  /**
   * A single binding row: per-key keycaps (same as shadcn Kbd, h-5/min-w-5 centered, symbols and
   * letters at the same size) + a pencil (clicking either the keycap or the pencil replaces that
   * binding). Keycaps override only the text color (custom = brand color) and pass no bg:
   * bg-inherit would go through cn's tailwind-merge and override Kbd's base bg-muted, and with the
   * whole ancestor chain transparent the chip background would disappear.
   */
  function renderBinding(binding: string, index: number) {
    return (
      <span key={binding} className="flex items-center gap-1.5">
        <button
          type="button"
          disabled={menuChannelUnavailable}
          className="w-fit rounded-lg px-0 py-1 text-left focus-visible:outline-2 focus-visible:outline-offset-4 disabled:cursor-not-allowed disabled:opacity-60"
          aria-label={intl.formatMessage(
            { id: "settings.shortcuts.rebindAria" },
            { command: commandLabel },
          )}
          data-testid={`settings-shortcut-bind-${entry.id}-${index}`}
          onClick={() => onRecord(index)}
        >
          <KbdGroup>
            {formatShortcutBindingLabelParts(binding).map((part, partIndex) => (
              <Kbd key={`${part}-${partIndex}`} className={isOverridden ? "text-brand" : undefined}>
                {part}
              </Kbd>
            ))}
          </KbdGroup>
        </button>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={menuChannelUnavailable}
          aria-label={intl.formatMessage(
            { id: "settings.shortcuts.rebindAria" },
            { command: commandLabel },
          )}
          data-testid={`settings-shortcut-edit-${entry.id}-${index}`}
          onClick={() => onRecord(index)}
        >
          <Pencil className="size-3.5" />
        </Button>
      </span>
    );
  }

  return (
    <div
      className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_80px_72px] items-center border-t border-border px-4 py-3 text-ui-base"
      data-testid={`settings-shortcut-row-${entry.id}`}
    >
      <span className="flex min-w-0 items-center">
        <span className="truncate">{commandLabel}</span>
      </span>
      <span className="flex min-w-0 flex-col items-start gap-1.5">
        {bindings.map((binding, index) =>
          isRecording && recording?.mode === "replace" && recording.bindingIndex === index
            ? renderRecorder()
            : renderBinding(binding, index),
        )}
        {/* Recording the first binding for an unassigned command: while recording, the state fills the key cell */}
        {isRecording && recording?.mode === "replace" && recording?.bindingIndex === null
          ? renderRecorder()
          : null}
        {bindings.length === 0 && !isRecording ? (
          <button
            type="button"
            disabled={menuChannelUnavailable}
            className="w-fit rounded-lg px-0 py-1 text-left focus-visible:outline-2 focus-visible:outline-offset-4 disabled:cursor-not-allowed disabled:opacity-60"
            aria-label={intl.formatMessage(
              { id: "settings.shortcuts.rebindAria" },
              { command: commandLabel },
            )}
            data-testid={`settings-shortcut-bind-${entry.id}-unassigned`}
            onClick={() => onRecord(null)}
          >
            <Kbd>{intl.formatMessage({ id: "settings.shortcuts.notSet" })}</Kbd>
          </button>
        ) : null}
      </span>
      {/* Scope is its own column: global = in effect everywhere; composer = in effect only inside the chat composer */}
      <span
        className="text-ui-sm text-foreground-subtle"
        data-testid={`settings-shortcut-scope-${entry.id}`}
      >
        {entry.scope === "composer"
          ? intl.formatMessage({ id: "settings.shortcuts.scopeComposer" })
          : intl.formatMessage({ id: "settings.shortcuts.scopeGlobal" })}
      </span>
      <Button
        variant="ghost"
        size="icon"
        aria-label={intl.formatMessage(
          { id: "settings.shortcuts.clearAria" },
          { command: commandLabel },
        )}
        // The menu channel command on the web side is grayed out along with the recording entrance: its default key is fixed for consumption by root-level fallback monitoring.
        // Clearing it to unallocated will not really invalidate it. Release will produce a split state of "showing unallocated but still triggering"
        disabled={menuChannelUnavailable || bindings.length === 0}
        onClick={onClearAll}
        data-testid={`settings-shortcut-clear-${entry.id}`}
      >
        <Trash2 className="size-4" />
      </Button>
    </div>
  );
}
