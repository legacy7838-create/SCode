import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import {
  SHORTCUT_COMMANDS,
  getDefaultShortcutBindings,
  type ShortcutCommandId,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  buildShortcutOverridesAfterAppend,
  buildShortcutOverridesAfterSteal,
  buildShortcutOverridesWithBindingAt,
  checkShortcutBindingConflict,
  isSamePhysicalBinding,
} from "@/shortcuts/conflicts.js";
import { formatShortcutBindingLabel } from "@/shortcuts/label.js";
import {
  resolveEffectiveShortcutBindings,
  setShortcutRecordingActive,
} from "@/shortcuts/bindings.js";
import { ShortcutBindingRow, type RecordingState } from "./ShortcutBindingRow.js";
import { ShortcutSearchBar } from "./ShortcutSearchBar.js";
import { useShortcutKeySearch } from "./useShortcutKeySearch.js";
import { useShortcutRecording } from "./useShortcutRecording.js";

/**
 * Shortcut settings section: a read-only view of the command table + keyboard capture + conflict
 * handling. It only reads and writes the shortcutBindings override data; all key semantics
 * (matching / capture / conflicts / takeover) go through the shortcuts kernel. System-reserved keys
 * are rejected outright; when an in-app command is occupied it names the occupying command and
 * supports a takeover after a second confirmation. Multiple bindings on one row: one command per
 * row, several keycap groups stacked vertically in the key column; each entry can be replaced or
 * deleted, and the command-level “+” appends; physically equivalent duplicates for the same command
 * are rejected at the capture entry point.
 */
export function ShortcutSettingsSection({ isDesktop = false }: { isDesktop?: boolean }) {
  const { intl } = useZCodeIntl();
  const { settings, update } = useSettings();
  const platform = usePlatform();
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<RecordingState | null>(null);
  const keySearch = useShortcutKeySearch();
  const savingRef = useRef(false);

  const overrides = settings?.shortcutBindings;
  const effective = useMemo(() => resolveEffectiveShortcutBindings(overrides), [overrides]);
  const commandLabel = useCallback(
    (commandId: ShortcutCommandId) =>
      intl.formatMessage({ id: `settings.shortcuts.command.${commandId}` }),
    [intl],
  );

  const visibleCommands = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    // Get local variables: TS in some callback closure cannot maintain the non-empty narrowing of keySearch.binding
    const keyBinding = keySearch.binding;
    return SHORTCUT_COMMANDS.filter((entry) => {
      // These shortcuts retain registration and conflict detection, but are not displayed in the user-visible list.
      if (entry.id === "openOnboarding" || entry.id === "toggleInterfaceMode") return false;
      const matchesText =
        !keyword ||
        entry.id.toLowerCase().includes(keyword) ||
        commandLabel(entry.id).toLowerCase().includes(keyword);
      // Key filtering uses the physical equivalent of conflict detection (win’s Ctrl+m ≡ CmdOrCtrl+m),
      // The conflict prompt with "Who occupies this set of keys" shows the same table.
      const matchesKey =
        keyBinding === null ||
        (effective[entry.id] ?? []).some((binding) => isSamePhysicalBinding(binding, keyBinding));
      return matchesText && matchesKey;
    });
  }, [commandLabel, effective, keySearch.binding, query]);

  const persistBindings = useCallback(
    async (next: Record<string, string[]>) => {
      if (savingRef.current) {
        return;
      }
      savingRef.current = true;
      try {
        await update({ shortcutBindings: next });
      } catch (error) {
        logger.error("[shortcuts] save shortcut bindings failed", { error: String(error) });
      } finally {
        savingRef.current = false;
      }
    },
    [update],
  );

  /**
   * Append one entry (the placeholder row's first captured binding also comes through here: when
   * the effective list is empty it is equivalent to writing the first entry).
   */
  const appendBinding = useCallback(
    (commandId: ShortcutCommandId, binding: string) => {
      void persistBindings(buildShortcutOverridesAfterAppend(overrides, commandId, binding));
    },
    [overrides, persistBindings],
  );

  /**
   * Replace entry bindingIndex of the effective list (whole-group replacement semantics — the full
   * effective list must be written).
   */
  const replaceBindingAt = useCallback(
    (commandId: ShortcutCommandId, bindingIndex: number, binding: string) => {
      void persistBindings(
        buildShortcutOverridesWithBindingAt(overrides, commandId, bindingIndex, binding),
      );
    },
    [overrides, persistBindings],
  );

  /**
   * The takeover after a second confirmation: the target command receives the new key using the
   * row-level semantics chosen at capture time (replace the specified entry / capture the first
   * when unassigned → append), and the conflicting key is removed from the occupying command. A
   * takeover only changes how the conflict is handled, not the row-level action the user originally
   * picked (a takeover on a multi-binding command must not silently delete the remaining bindings).
   */
  const stealBinding = useCallback(
    (commandId: ShortcutCommandId, binding: string) => {
      const next = buildShortcutOverridesAfterSteal(overrides, commandId, binding, {
        mode: recording?.mode,
        bindingIndex: recording?.bindingIndex,
      });
      void persistBindings(next);
    },
    [overrides, persistBindings, recording],
  );

  /**
   * The trash “Clear” in the action column = remove all bindings of that command = unassigned: the
   * override is written as an explicit empty array, with no fallback to defaults (including
   * dropping the menu-channel accelerator). That is a different semantic from “restore default” on
   * Backspace in the capture state.
   */
  const clearAllBindings = useCallback(
    (commandId: ShortcutCommandId) => {
      void persistBindings({ ...overrides, [commandId]: [] });
    },
    [overrides, persistBindings],
  );

  /**
   * “Restore default” on Backspace in the capture state = delete the override entry. When the
   * default key is occupied by another command in the same scope (including physical equivalence,
   * e.g. on win Ctrl+m ≡ CmdOrCtrl+m) the conflict is reported and nothing is persisted — restoring
   * defaults and capturing are two entry points into the same invariant (one key, one command); per
   * the user's account it only warns and never auto-clears the occupying side.
   */
  const clearBinding = useCallback(
    (commandId: ShortcutCommandId) => {
      if (overrides?.[commandId] === undefined) {
        return;
      }
      const defaultBinding = getDefaultShortcutBindings(commandId)[0];
      if (defaultBinding) {
        const conflict = checkShortcutBindingConflict(commandId, defaultBinding, overrides, {
          menuChannelReserved: !isDesktop,
        });
        if (conflict?.kind === "occupied" && conflict.ownerCommandId) {
          toast(
            intl.formatMessage(
              { id: "settings.shortcuts.clearConflict" },
              { command: commandLabel(conflict.ownerCommandId) },
            ),
          );
          return;
        }
      }
      const next = { ...overrides };
      delete next[commandId];
      void persistBindings(next);
    },
    [overrides, persistBindings, isDesktop, intl, commandLabel],
  );

  // "Restore all to default" is a destructive operation (clearing all custom key overlays), reusing the global confirmation pop-up window (Promise style) to prevent one-key accidental touch
  const requestConfirmation = useConfirmDialogStore((state) => state.requestConfirmation);
  const resetAll = useCallback(async () => {
    if (!overrides || Object.keys(overrides).length === 0) {
      return;
    }
    const confirmed = await requestConfirmation({
      title: intl.formatMessage({ id: "settings.shortcuts.resetAllConfirmTitle" }),
      description: intl.formatMessage({ id: "settings.shortcuts.resetAllConfirmDescription" }),
    });
    if (confirmed) {
      void persistBindings({});
    }
  }, [overrides, persistBindings, requestConfirmation, intl]);

  // Recording state suppression: the recording monitor registration is later than the capture monitor of useAppKeyboard (register first and execute first in the same stage).
  // If it is not suppressed, the recorded pressed combination will trigger the original command first, and the key change will never succeed.
  // The renderer channel relies on the kernel mark to short-circuit useAppKeyboard; the menu channel relies on main to remove the menu accelerator.
  // (The macOS system menu eats keys before the renderer, preventDefault cannot stop it).
  // The key search armed state reuses the same keyboard exclusively (it also captures key combinations with explicit intent and does not trigger commands).
  const keyboardExclusive = recording !== null || keySearch.armed;
  useEffect(() => {
    if (!keyboardExclusive) {
      return;
    }
    setShortcutRecordingActive(true);
    platform.setShortcutRecordingActive?.(true);
    return () => {
      setShortcutRecordingActive(false);
      platform.setShortcutRecordingActive?.(false);
    };
  }, [keyboardExclusive, platform]);

  useShortcutRecording({
    recording,
    setRecording,
    effective,
    overrides,
    isDesktop,
    clearBinding,
    appendBinding,
    replaceBindingAt,
  });

  const recordingCommandId = recording?.commandId ?? null;

  return (
    <div className="space-y-4" data-testid="settings-shortcuts-section">
      <ShortcutSearchBar
        query={query}
        onQueryChange={setQuery}
        keySearch={keySearch}
        // Mutually exclusive with in-line recording: cancel ongoing recording before arming, two sets of window capture monitoring do not coexist
        onArmKeySearch={() => setRecording(null)}
        actions={
          <Button
            variant="outline"
            onClick={resetAll}
            disabled={!overrides || Object.keys(overrides).length === 0}
            data-testid="settings-shortcut-reset-all"
          >
            <RotateCcw className="mr-2 size-4" />
            {intl.formatMessage({ id: "settings.shortcuts.resetAll" })}
          </Button>
        }
      />

      <div className="overflow-hidden rounded-xl border border-border">
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_80px_72px] bg-surface px-4 py-3 text-ui-sm text-foreground-subtle">
          <span>{intl.formatMessage({ id: "settings.shortcuts.columnHeaderCommand" })}</span>
          <span>{intl.formatMessage({ id: "settings.shortcuts.columnHeaderBinding" })}</span>
          <span>{intl.formatMessage({ id: "settings.shortcuts.columnHeaderScope" })}</span>
          <span>{intl.formatMessage({ id: "settings.shortcuts.columnHeaderActions" })}</span>
        </div>
        {visibleCommands.map((entry) => (
          <ShortcutBindingRow
            key={entry.id}
            entry={entry}
            commandLabel={commandLabel(entry.id)}
            bindings={effective[entry.id] ?? []}
            isOverridden={overrides?.[entry.id] !== undefined}
            isRecording={recordingCommandId === entry.id}
            recording={recording}
            menuChannelUnavailable={entry.channel === "menu" && !isDesktop}
            onRecord={(bindingIndex) => {
              // Inline recording and key search armed state are mutually exclusive: two sets of window capture monitors coexisting will swallow each other's keys
              keySearch.disarm();
              setRecording({
                commandId: entry.id,
                mode: "replace",
                bindingIndex,
                preview: null,
                error: null,
                conflictBinding: null,
              });
            }}
            onSteal={(binding) => {
              stealBinding(entry.id, binding);
              setRecording(null);
            }}
            onClearAll={() => clearAllBindings(entry.id)}
          />
        ))}
        {visibleCommands.length === 0 ? (
          <div
            className="border-t border-border px-4 py-8 text-center text-ui-sm text-foreground-subtle"
            data-testid="settings-shortcut-search-empty"
          >
            {keySearch.binding !== null
              ? intl.formatMessage(
                  { id: "settings.shortcuts.keySearchEmpty" },
                  { keys: formatShortcutBindingLabel(keySearch.binding) },
                )
              : intl.formatMessage({ id: "settings.shortcuts.searchEmpty" })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
