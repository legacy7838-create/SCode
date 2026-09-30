import type { ZCodeConfigOption, ZCodeProvider, ZCodeTaskMode } from "@zcode/shared";

const CANONICAL_SESSION_MODES = new Set<ZCodeTaskMode>([
  "yolo",
  "plan",
  "edit",
  "auto",
  "autoEdit",
  "build",
]);

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function getModeConfigOption(options: readonly ZCodeConfigOption[]): ZCodeConfigOption | undefined {
  return options.find((option) => option.category === "mode" && option.type === "select");
}

function normalizePersistedSessionMode(
  modeId: string | null | undefined,
  _provider?: ZCodeProvider,
): ZCodeTaskMode | undefined {
  const trimmedModeId = readTrimmedString(modeId);
  if (!trimmedModeId) {
    return undefined;
  }

  if (CANONICAL_SESSION_MODES.has(trimmedModeId as ZCodeTaskMode)) {
    return trimmedModeId as ZCodeTaskMode;
  }

  switch (trimmedModeId) {
    // Bugfix: The provider's native modeId and the local persistent session mode are not a set of enumerations.
    // Before sending, the local semantics need to be mapped back to the actual value in the provider options.
    case "read-only":
    case "read_only":
      return "plan";
    case "full-auto":
    case "full_auto":
      return "yolo";
    default:
      return undefined;
  }
}

export function resolveProviderModeIdFromConfigOptions(params: {
  configOptions: readonly ZCodeConfigOption[];
  modeId: string | null | undefined;
  provider?: ZCodeProvider;
}): string | undefined {
  const requestedMode = readTrimmedString(params.modeId);
  if (!requestedMode) {
    return undefined;
  }

  const modeOption = getModeConfigOption(params.configOptions);
  const candidates = modeOption?.options ?? [];
  const exactMatch = candidates.find((candidate) => candidate.value === requestedMode);
  if (exactMatch) {
    return exactMatch.value;
  }

  const requestedPersistedMode = normalizePersistedSessionMode(
    requestedMode,
    params.provider,
  );
  if (!requestedPersistedMode) {
    return undefined;
  }

  const semanticMatch = candidates.find(
    (candidate) =>
      normalizePersistedSessionMode(candidate.value, params.provider) ===
      requestedPersistedMode,
  );

  return semanticMatch?.value;
}
