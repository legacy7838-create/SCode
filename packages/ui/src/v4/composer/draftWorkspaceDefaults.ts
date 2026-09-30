// The toolbar only displays Composer's next commit selection; Session is not a source of complement for surviving editors.
import type { ZCodeConfigOption } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import { resolveModelThoughtOption } from "@/lib/modelThoughtOption.js";
/**
 * Projects only the structured selection onto the existing display controls; an empty selection
 * must not be padded out with a stale Snapshot or a flattened alias.
 */
export function resolveDraftDisplayedConfig(
  composer: Partial<SessionConfigState>,
): SessionConfigState | null {
  const selection = composer.modelSelection;
  if (!selection) return null;
  return {
    modelSelection: selection,
    provider: selection.providerId,
    model: selection.modelId,
    thought: selection.options?.reasoningLevel ?? "",
    thoughtLevels: [],
    followupMode: composer.followupMode ?? "queue",
    mode: composer.mode ?? "build",
  };
}

export function resolveDraftModelThoughtOption(
  providerId: string,
  modelId: string,
  modelSelectionView: ModelSelectionView | null,
): ZCodeConfigOption | null {
  if (!modelSelectionView) return null;
  return resolveModelThoughtOption({
    modelSelectionView,
    providerId,
    modelId,
  });
}

export function resolveDraftThoughtCurrentValue(params: {
  thought: string | null | undefined;
  thoughtLevels: readonly string[];
}): string {
  const explicitThought = params.thought?.trim() ?? "";
  if (explicitThought && params.thoughtLevels.includes(explicitThought)) {
    return explicitThought;
  }

  // The presentation layer used the directory default value/first item to fill in the empty values, making the unbound old session appear to have selected the file.
  // The current value only recognizes the selection result; the completion of new/active mode selection is the responsibility of the Selection entry, and the restored null value must be retained.
  return "";
}
