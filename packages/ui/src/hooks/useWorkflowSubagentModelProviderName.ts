import { useMemo } from "react";
import type { ZCodeConfigOption } from "@zcode/shared";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

/**
 * Where the provider name of a subagent model comes from: the session's model list (the entry in
 * the workspace configOptions with category === "model") already carries `modelProviderId` /
 * `modelProviderName`, so there is no need to open a second provider catalog just for one line of
 * text.
 *
 * It yields a **name** only, never an id: when there is no providerLabel, `modelProviderName` falls
 * back to the providerId itself (see zcodeSessionSettingsToConfigOptions), and such a "name" counts
 * as no name here — a providerId must never appear on screen (on team plans it is a UUID).
 */
function workflowSubagentProviderNameLookup(
  configOptions: readonly ZCodeConfigOption[] | null | undefined,
): ((providerId: string) => string | undefined) | undefined {
  const entries = configOptions?.find((option) => option.category === "model")?.options;
  if (entries === undefined) {
    return undefined;
  }
  const names = new Map<string, string>();
  for (const entry of entries) {
    const providerId = entry.modelProviderId?.trim();
    const providerName = entry.modelProviderName?.trim();
    if (!providerId || !providerName || providerName === providerId) {
      continue;
    }
    if (!names.has(providerId)) {
      names.set(providerId, providerName);
    }
  }
  return names.size === 0 ? undefined : (providerId: string) => names.get(providerId);
}

/**
 * The hook form of the table above. When workspacePath is absent (the host cannot provide a scope)
 * there is no lookup function — the name-composition rule then falls back to the bare modelId,
 * which is a deliberate fallback, not a defect.
 */
export function useWorkflowSubagentModelProviderName(
  workspacePath: string | undefined,
  workspaceIdentity?: string,
): ((providerId: string) => string | undefined) | undefined {
  const configOptions = useZCodeSessionStore((state) =>
    workspacePath === undefined
      ? undefined
      : selectWorkspaceZCodeState(state, workspacePath, workspaceIdentity).configOptions,
  );
  return useMemo(() => workflowSubagentProviderNameLookup(configOptions), [configOptions]);
}
