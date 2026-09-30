import type { ZCodeConfigOption, ZCodeTaskMeta } from "@zcode/shared";
import { getZCodeAgentModeSelectOptions } from "@zcode/shared";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";

function parseProviderQualifiedModel(
  model: string,
): { providerId: string; modelName: string } | null {
  const normalizedModel = model.trim();
  const separatorIndex = normalizedModel.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex >= normalizedModel.length - 1) {
    return null;
  }

  const providerId = normalizedModel.slice(0, separatorIndex).trim();
  const modelName = normalizedModel.slice(separatorIndex + 1).trim();
  if (!providerId || !modelName) {
    return null;
  }

  return { providerId, modelName };
}

function isSyntheticModelPlaceholder(model: string): boolean {
  return model.trim().toLocaleLowerCase() === "<synthetic>";
}

function resolveGlmRecoveredTaskModelValue(taskModel: string | undefined): string | null {
  const normalizedTaskModel = taskModel?.trim();
  if (!normalizedTaskModel || isSyntheticModelPlaceholder(normalizedTaskModel)) {
    return null;
  }

  const customModel = decodeCustomModelValue(normalizedTaskModel);
  if (customModel?.providerId && customModel.modelName) {
    return normalizedTaskModel;
  }

  const providerQualifiedModel = parseProviderQualifiedModel(normalizedTaskModel);
  if (providerQualifiedModel) {
    return encodeCustomModelValue(
      providerQualifiedModel.providerId,
      providerQualifiedModel.modelName,
    );
  }

  return normalizedTaskModel;
}

function resolveRecoveredTaskModelValue(
  taskMeta: Pick<ZCodeTaskMeta, "provider" | "model">,
): string | null {
  const normalizedTaskModel = taskMeta.model?.trim();
  if (!normalizedTaskModel || isSyntheticModelPlaceholder(normalizedTaskModel)) {
    return null;
  }

  if (taskMeta.provider === "glm") {
    return resolveGlmRecoveredTaskModelValue(normalizedTaskModel);
  }

  return normalizedTaskModel;
}

function resolveModelOptionName(modelValue: string): string {
  const customModel = decodeCustomModelValue(modelValue);
  const providerQualifiedModel = parseProviderQualifiedModel(modelValue);
  return customModel?.modelName?.trim() || providerQualifiedModel?.modelName || modelValue;
}

function ensureModelOptionValue(option: ZCodeConfigOption, modelValue: string): ZCodeConfigOption {
  const options = option.options ?? [];
  const hasOption = options.some((candidate) => candidate.value === modelValue);
  if (hasOption && option.currentValue === modelValue) {
    return option;
  }

  return {
    ...option,
    currentValue: modelValue,
    options: hasOption
      ? options
      : [
          ...options,
          {
            name: resolveModelOptionName(modelValue),
            value: modelValue,
          },
        ],
  };
}

function createRecoveredModelOption(modelValue: string): ZCodeConfigOption {
  return {
    category: "model",
    currentValue: modelValue,
    id: "model",
    name: "Model",
    options: [
      {
        name: resolveModelOptionName(modelValue),
        value: modelValue,
      },
    ],
    type: "select",
  };
}

function createRecoveredModeOption(modeValue: string): ZCodeConfigOption {
  return {
    category: "mode",
    currentValue: modeValue,
    id: "mode",
    name: "Mode",
    options: getZCodeAgentModeSelectOptions(),
    type: "select",
  };
}

function createRecoveredThoughtLevelOption(thoughtLevel: string): ZCodeConfigOption {
  return {
    category: "thought_level",
    currentValue: thoughtLevel,
    id: "thought_level",
    name: "Effort",
    options: [
      {
        name: thoughtLevel,
        value: thoughtLevel,
      },
    ],
    type: "select",
  };
}

function ensureSelectOptionCurrentValue(
  option: ZCodeConfigOption,
  value: string,
): ZCodeConfigOption {
  const options = option.options ?? [];
  const hasOption = options.some((candidate) => candidate.value === value);
  if (hasOption && option.currentValue === value) {
    return option;
  }

  return {
    ...option,
    currentValue: value,
    options: hasOption
      ? options
      : [
          ...options,
          {
            name: value,
            value,
          },
        ],
  };
}

function mergeRecoveredTaskModelConfigOptions({
  taskMeta,
  configOptions,
}: {
  taskMeta: Pick<ZCodeTaskMeta, "provider" | "model">;
  configOptions: readonly ZCodeConfigOption[];
}): ZCodeConfigOption[] | null {
  const recoveredModelValue = resolveRecoveredTaskModelValue(taskMeta);
  if (!recoveredModelValue) {
    return null;
  }

  let hasModelOption = false;
  let changed = false;
  const nextConfigOptions = configOptions.map((option) => {
    if (option.category !== "model" || option.type !== "select") {
      return option;
    }

    hasModelOption = true;
    const nextOption = ensureModelOptionValue(option, recoveredModelValue);
    changed = changed || nextOption !== option;
    return nextOption;
  });

  if (!hasModelOption) {
    // When the historical task is resumed, resume/config_option_update may be later than the first frame rendering.
    // Only clearing the configuration of the previous task will cause the toolbar to briefly return to "Select Model"; here use task.meta.model
    // Synthesize the minimum model items, first display the persistent model stably, and then overwrite the real configOptions after they are returned.
    return [createRecoveredModelOption(recoveredModelValue), ...nextConfigOptions];
  }

  // task.meta.model may have been written back to the task configuration when the old session is restored.
  // If a new array is returned when there is no change, the caller will repeatedly setTaskConfigOptions, and the toolbar recovery effect will trigger each other.
  return changed ? nextConfigOptions : null;
}

export function resolveTaskRestorePreloadConfigOptions({
  taskMeta,
  cachedTaskConfigOptions,
}: {
  taskMeta: Pick<ZCodeTaskMeta, "provider" | "model"> &
    Partial<Pick<ZCodeTaskMeta, "mode" | "thoughtLevel">>;
  cachedTaskConfigOptions?: readonly ZCodeConfigOption[];
}): ZCodeConfigOption[] {
  let cachedOptions = [...(cachedTaskConfigOptions ?? [])];
  const recoveredOptions = mergeRecoveredTaskModelConfigOptions({
    taskMeta,
    configOptions: cachedOptions,
  });

  if (recoveredOptions) {
    cachedOptions = recoveredOptions;
  }

  const mode = taskMeta.mode?.trim();
  if (taskMeta.provider === "glm" && mode) {
    let hasModeOption = false;
    cachedOptions = cachedOptions.map((option) => {
      if (option.category !== "mode" || option.type !== "select") {
        return option;
      }
      hasModeOption = true;
      return ensureSelectOptionCurrentValue(option, mode);
    });
    if (!hasModeOption) {
      // For tasks triggered by scheduled tasks, composer can only get task meta before the real settings are returned.
      // Here, the minimum mode option is synthesized from meta to prevent the permission entry from temporarily displaying the workspace default value.
      cachedOptions = [createRecoveredModeOption(mode), ...cachedOptions];
    }
  }

  const thoughtLevel = taskMeta.thoughtLevel?.trim();
  if (taskMeta.provider === "glm" && thoughtLevel) {
    let hasThoughtOption = false;
    cachedOptions = cachedOptions.map((option) => {
      if (option.category !== "thought_level" || option.type !== "select") {
        return option;
      }
      hasThoughtOption = true;
      return ensureSelectOptionCurrentValue(option, thoughtLevel);
    });
    if (!hasThoughtOption) {
      // Like mode, automation task-local thoughtLevel needs to be echoed from task meta first;
      // Subsequent session settings will complete the complete thought options supported by this model.
      cachedOptions = [...cachedOptions, createRecoveredThoughtLevelOption(thoughtLevel)];
    }
  }

  // The historical task has been opened and expired. TaskConfigOptionsByTaskId contains complete
  // model/mode/thought_level. If the recovery period is cleared just because task.meta.model is missing,
  // The toolbar will hide mode/thought first and then appear again after the new snapshot is returned; the task-level cache is retained here.
  // If the real new settings are missing, they will be overwritten and hidden by setTaskConfigOptions.
  return cachedOptions;
}
