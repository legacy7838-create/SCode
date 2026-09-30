import type {
  ZCodeConfigOption,
  ZCodeMessageWithParts,
  ModelSelection,
  ZCodeSessionMode,
  ZCodeSessionSettingsState,
  ZCodeSessionStateSnapshot,
  ZCodeTaskModeInfo,
} from "@zcode/shared";
import {
  formatModelPickerValue as formatSharedModelSelection,
  getZCodeAgentAvailableModes as getSharedZCodeAgentAvailableModes,
  normalizeAvailableZCodeMode as normalizeSharedAvailableZCodeMode,
  zcodeSessionSettingsToZCodeConfigOptions,
} from "@zcode/shared";

export const MODEL_CONFIG_ID = "model";
export const MODE_CONFIG_ID = "mode";
export const THOUGHT_LEVEL_CONFIG_ID = "thought_level";

export function formatModelPickerValue(ref: ModelSelection | undefined): string {
  return formatSharedModelSelection(ref);
}

function resolveLatestMessageModelSelection(
  messages: readonly ZCodeMessageWithParts[],
): ModelSelection | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const model = messages[index]?.info.model;
    if (model) {
      return model;
    }
  }
  return undefined;
}

function resolveTaskMetaModelSelectionFromSnapshot(
  snapshot: Pick<ZCodeSessionStateSnapshot, "messages" | "settings">,
): ModelSelection | undefined {
  // Historical resume may have overridden settings.current with the app's current default model,
  // But the message info.model still retains the actual used model. task meta is a history recovery hint,
  // Priority should be given to recording the model actually used by recent messages to avoid erroneous snapshots from continuing to pollute the task index.
  return resolveLatestMessageModelSelection(snapshot.messages) ?? snapshot.settings.model.current;
}

export function formatTaskMetaModelSelectionFromSnapshot(
  snapshot: Pick<ZCodeSessionStateSnapshot, "messages" | "settings">,
): string {
  return formatModelPickerValue(resolveTaskMetaModelSelectionFromSnapshot(snapshot));
}

export function normalizeAvailableZCodeMode(mode: ZCodeSessionMode): string {
  return normalizeSharedAvailableZCodeMode(mode);
}

export function getZCodeAgentAvailableModes(): ZCodeTaskModeInfo[] {
  return getSharedZCodeAgentAvailableModes();
}

export function settingsToConfigOptions(settings: ZCodeSessionSettingsState): ZCodeConfigOption[] {
  // The service side once maintained a three-mode whitelist, and the edit mode was not synchronized after it went online.
  // When switching modes, mode_update will overwrite the UI menu to build/plan/yolo. The shared source of fact is uniformly reused here.
  return zcodeSessionSettingsToZCodeConfigOptions(settings);
}
