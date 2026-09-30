/**
 * V4 composer toolbar keyboard shortcuts (composer parity).
 *
 * Judged to be pure logic (no store / protocol dependencies; it only consumes config catalog
 * options and callbacks). The callbacks at the binding site only mutate the Composer:
 * - Ctrl+M → open the model menu (openRequestKey increments, consumed by ModelConfigSelect)
 * - Ctrl+Shift+M → cycle the mode of the next Submission
 * - Ctrl+T → cycle the thought depth of the next Submission
 *
 * All three shortcuts have been promoted to command-table commands (openModelMenu /
 * cycleSessionMode / cycleThoughtLevel, global scope on the window channel); key matching reads the
 * effective table, so they can be rebound in the settings page. The default keys keep the existing
 * behavior, with zero change.
 */
import { useEffect, useRef } from "react";
import type { ShortcutCommandId, ZCodeConfigOption } from "@zcode/shared";
import {
  isShortcutRecordingActive,
  matchesShortcutBinding,
  type EffectiveShortcutBindings,
} from "@/shortcuts/bindings.js";
import { useEffectiveShortcutBindings } from "@/shortcuts/useShortcutBindings.js";
import { logger } from "@/logger.js";

type ChatToolbarShortcutKey = "m" | "ctrlShiftM" | "t" | null;

/** Resolves the toolbar shortcut slot by config category. */
function getChatToolbarShortcutKey(
  category: ZCodeConfigOption["category"],
): ChatToolbarShortcutKey {
  switch (category) {
    case "model":
      return "m";
    case "mode":
      return "ctrlShiftM";
    case "thought_level":
      return "t";
    default:
      return null;
  }
}

/** Computes the next cyclic value of a select's options (used for mode cycling). */
export function getNextConfigSelectValue(
  option: Pick<ZCodeConfigOption, "type" | "currentValue" | "options">,
): string | null {
  if (option.type !== "select" || !option.options?.length) {
    return null;
  }

  const currentValue = String(option.currentValue);
  const currentIndex = option.options.findIndex((candidate) => candidate.value === currentValue);
  const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % option.options.length;

  return option.options[nextIndex]?.value ?? null;
}

interface ToolbarShortcutKeyboardEvent {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  repeat: boolean;
  isComposing: boolean;
}

interface ToolbarShortcutState {
  hasAnyOption: boolean;
  toolbarDisabled: boolean;
  modelMenuDisabled: boolean;
  modelOption?: ZCodeConfigOption;
  modeOption?: ZCodeConfigOption;
  thoughtOption?: ZCodeConfigOption;
}

type ToolbarShortcutAction = "openModelMenu" | "cycleSessionMode" | "cycleThoughtLevel";

/**
 * Resolves the toolbar action from the effective table (the toolbar shortcuts have been promoted to
 * configurable commands). Key matching goes through the kernel (command table + matcher, with exact
 * modifier matching and semantics consistent with the old matchesCtrlShortcut family for "Ctrl+m" /
 * "Ctrl+Shift+m" / "Ctrl+t"); the original option ownership and the disabled gating stay unchanged.
 * The event and the effective table are passed in by the caller, and the pure function can be
 * unit-tested on its own.
 */
function resolveToolbarShortcutAction(
  event: ToolbarShortcutKeyboardEvent,
  effective: EffectiveShortcutBindings,
  {
    hasAnyOption,
    toolbarDisabled,
    modelMenuDisabled,
    modelOption,
    modeOption,
    thoughtOption,
  }: ToolbarShortcutState,
): ToolbarShortcutAction | null {
  if (
    !hasAnyOption ||
    toolbarDisabled ||
    event.defaultPrevented ||
    event.repeat ||
    event.isComposing
  ) {
    return null;
  }

  const candidates: ReadonlyArray<{
    action: ToolbarShortcutAction;
    commandId: ShortcutCommandId;
    expectedKey: ChatToolbarShortcutKey;
    option?: ZCodeConfigOption;
    disabled?: boolean;
  }> = [
    {
      action: "openModelMenu",
      commandId: "openModelMenu",
      expectedKey: "m",
      option: modelOption,
      disabled: modelMenuDisabled,
    },
    {
      action: "cycleSessionMode",
      commandId: "cycleSessionMode",
      expectedKey: "ctrlShiftM",
      option: modeOption,
    },
    {
      action: "cycleThoughtLevel",
      commandId: "cycleThoughtLevel",
      expectedKey: "t",
      option: thoughtOption,
    },
  ];

  for (const candidate of candidates) {
    if (candidate.disabled) {
      continue;
    }
    if (
      !candidate.option ||
      getChatToolbarShortcutKey(candidate.option.category) !== candidate.expectedKey
    ) {
      continue;
    }
    for (const binding of effective[candidate.commandId] ?? []) {
      if (matchesShortcutBinding(event, binding)) {
        return candidate.action;
      }
    }
  }

  return null;
}

export function useToolbarShortcutBindings(params: {
  hasAnyOption: boolean;
  toolbarDisabled: boolean;
  modelMenuDisabled: boolean;
  modelOption?: ZCodeConfigOption;
  modeOption?: ZCodeConfigOption;
  thoughtOption?: ZCodeConfigOption;
  onOpenModelMenu: () => void;
  /**
   * Ctrl+Shift+M: mirrors the thought level by quickly switching the session mode in option order,
   * without opening the menu.
   */
  onCycleSessionMode: () => void;
  /**
   * Ctrl+T: keeps the fast thought-level switch, unaffected by the default select menu interaction.
   */
  onCycleThoughtLevel: () => void;
}) {
  const {
    hasAnyOption,
    toolbarDisabled,
    modelMenuDisabled,
    modelOption,
    modeOption,
    thoughtOption,
    onOpenModelMenu,
    onCycleSessionMode,
    onCycleThoughtLevel,
  } = params;
  // The toolbar hotkeys have been converted to command table commands, and the key position matching reads the effective table - it will take effect immediately after the setting page is changed.
  const effectiveBindings = useEffectiveShortcutBindings();
  const effectiveRef = useRef(effectiveBindings);
  effectiveRef.current = effectiveBindings;

  useEffect(() => {
    if (!hasAnyOption) {
      return;
    }

    function handleWindowKeydown(event: KeyboardEvent) {
      // The recording keyboard is exclusive to the recorder. This monitor is registered before the recording monitor (same as the capture stage).
      // If there is no short circuit, the key preview during recording will actually trigger the toolbar action.
      if (isShortcutRecordingActive()) {
        return;
      }
      // Cmd/Ctrl+P on Windows/Linux is used by useAppKeyboard for Search
      // File", which conflicts with similar keys in the old version of the toolbar ⌃P. Mode switching changed to Ctrl+Shift+M, still respected
      // defaultPrevented, to avoid repeated processing with other capture phase shortcut keys.
      const state = {
        hasAnyOption,
        toolbarDisabled,
        modelMenuDisabled,
        modelOption,
        modeOption,
        thoughtOption,
      };
      const action = resolveToolbarShortcutAction(event, effectiveRef.current, state);
      if (!action) {
        // The diagnostic log is decoupled from the validation table - it is only logged when the pressed key is actually bound to openModelMenu
        // "Model menu is not opened" (pressing the old key after rebinding should not be accidentally hit, and there will no longer be no log if the new key fails after rebinding).
        const openModelMenuBound = (effectiveRef.current.openModelMenu ?? []).some((binding) =>
          matchesShortcutBinding(event, binding),
        );
        if (openModelMenuBound) {
          logger.debug("[V4ComposerToolbar] model menu shortcut did not open the model menu", {
            hasModelOption: Boolean(modelOption),
            shortcutKey: getChatToolbarShortcutKey(modelOption?.category),
            modelMenuDisabled,
          });
        }
        return;
      }

      event.preventDefault();
      if (action === "openModelMenu") {
        logger.debug("[V4ComposerToolbar] Ctrl+M opened the model menu");
        onOpenModelMenu();
        return;
      }

      if (action === "cycleSessionMode") {
        onCycleSessionMode();
        return;
      }

      if (action === "cycleThoughtLevel") {
        onCycleThoughtLevel();
      }
    }

    window.addEventListener("keydown", handleWindowKeydown, true);
    return () => {
      window.removeEventListener("keydown", handleWindowKeydown, true);
    };
  }, [
    hasAnyOption,
    toolbarDisabled,
    modelMenuDisabled,
    modeOption,
    modelOption,
    onOpenModelMenu,
    onCycleSessionMode,
    onCycleThoughtLevel,
    thoughtOption,
  ]);
}
