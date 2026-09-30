export const AUTOMATION_MUTATION_TOOL_NAMES = ["CronCreate", "CronUpdate", "CronDelete"] as const;

export function mergeAutomationMutationToolDenylist(
  current: readonly string[] | undefined,
): string[] {
  const merged = new Set(current);
  for (const toolName of AUTOMATION_MUTATION_TOOL_NAMES) {
    merged.add(toolName);
  }
  return [...merged];
}

// The idle-time dispatch wheel only denies OffPeakCreate (to prevent idle-time tasks from recursively self-deriving and infinite scheduling), and OffPeakList is read-only and reserved.
// Standalone constant, never merged into AUTOMATION_MUTATION_TOOL_NAMES - cron automation wheel
// Explicitly release OffPeakCreate (scheduled idle time task), mixing in will cause automation to deny in turn.
export const OFF_PEAK_MUTATION_TOOL_NAMES = ["OffPeakCreate"] as const;

export function mergeOffPeakMutationToolDenylist(current: readonly string[] | undefined): string[] {
  const merged = new Set(current);
  for (const toolName of OFF_PEAK_MUTATION_TOOL_NAMES) {
    merged.add(toolName);
  }
  return [...merged];
}
