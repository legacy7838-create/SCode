import type { ZCodePluginInfo, ZCodePluginUserConfigOption } from "@zcode/shared";

export type PluginOptionDraftValue = string | number | boolean | null;

interface PluginConfigPatch {
  options: Record<string, string | number | boolean>;
  clearOptionKeys: string[];
}

/**
 * Builds the patch that writes Plugin configuration.
 *
 * `configuredOptions` holds the effective values of the current scope and must not be written back
 * as one whole draft on save; otherwise a Workspace page that changes a single field would also
 * freeze the other User/default fields into Workspace overrides. Only fields that explicitly
 * produce a draft belong to this write.
 */
export function buildPluginConfigPatch(
  plugin: Pick<ZCodePluginInfo, "userConfig">,
  drafts: Record<string, PluginOptionDraftValue | undefined>,
): PluginConfigPatch {
  const options: Record<string, string | number | boolean> = {};
  const clearOptionKeys: string[] = [];

  for (const [key, option] of Object.entries(plugin.userConfig ?? {}) as [
    string,
    ZCodePluginUserConfigOption,
  ][]) {
    const draft = drafts[key];
    if (draft === undefined) continue;
    if (draft === null) {
      clearOptionKeys.push(key);
      continue;
    }

    // The empty string of Sensitive still means "do not modify the existing value", and only null is explicitly cleared.
    if (option.sensitive && draft === "") continue;

    if (option.type === "number") {
      const numeric = typeof draft === "number" ? draft : Number(draft);
      if (Number.isFinite(numeric)) options[key] = numeric;
      continue;
    }
    options[key] = draft;
  }

  return { options, clearOptionKeys };
}
