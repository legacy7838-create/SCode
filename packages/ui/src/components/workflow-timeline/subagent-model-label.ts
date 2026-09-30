import { thoughtLevelLabelId } from "@/chat-input-toolbar/thoughtLevelOptions.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import { formatProviderModelLabel } from "@/v4/composer/modelTriggerDisplay.js";

/**
 * The **words** for a subagent model: what a run stores is the canonical string
 * `providerId/modelId[$reasoningLevel]` — that is for machines to backfill, not for humans to read.
 * On team plans the providerId is a UUID, and pasted onto the screen as-is, the first thing a user
 * sees is a run of hex digits.
 *
 * So the three surfaces (the confirmation dialog, the run card, the detail side panel) share this
 * one pure function: the name-composition rule reuses the model menu's own
 * (`formatProviderModelLabel`: built-in families show only the model name, custom providers show
 * "name/model"), and the reasoning level reuses the reasoning control's vocabulary. The canonical
 * string itself only lives in the tooltip.
 *
 * Pure function + injected formatMessage / providerName: the same discipline as timeline-summary,
 * this file does not touch the store.
 */
type FormatMessage = (
  descriptor: { id: string },
  values?: Record<string, string | number>,
) => string;

export interface WorkflowSubagentModelLabel {
  /** Model name on screen; **never contains the providerId**. */
  name: string;
  /** Localized reasoning level word; absent when the canonical string has no `$level`. */
  level?: string;
  /** The canonical string verbatim (trimmed), tooltip only. */
  canonical: string;
}

export interface WorkflowSubagentModelDeps {
  formatMessage: FormatMessage;
  /**
   * providerId → the provider name in the session model list. Falls back to the bare modelId when
   * absent (or not found) — this fallback is **deliberate**: when the name cannot be resolved the
   * providerId is still never put on screen.
   */
  providerName?: (providerId: string) => string | undefined;
}

/**
 * Fallback naming when the structure cannot be parsed: cut the `providerId/` prefix and the
 * `$level` suffix, and whatever remains is the part a human can read.
 */
function fallbackName(canonical: string): string {
  const separatorIndex = canonical.indexOf("/");
  const rest = separatorIndex > 0 ? canonical.slice(separatorIndex + 1) : canonical;
  const levelIndex = rest.indexOf("$");
  const name = levelIndex > 0 ? rest.slice(0, levelIndex) : rest;
  return name.length > 0 ? name : canonical;
}

/**
 * Canonical string → the words on screen. Parse failures (the string is missing its provider
 * segment, or its shape does not match the schema) do not throw: the UI is not a second parser, so
 * when in doubt it falls back to the bare modelId.
 */
export function describeWorkflowSubagentModel(
  canonical: string,
  deps: WorkflowSubagentModelDeps,
): WorkflowSubagentModelLabel {
  const trimmed = canonical.trim();
  let parsed: ReturnType<typeof parseModelPickerValue> | undefined;
  try {
    parsed = parseModelPickerValue(trimmed);
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined) {
    return { canonical: trimmed, name: fallbackName(trimmed) };
  }

  // If providerName cannot be found in the session list, providerId itself will be returned (see zcodeSessionSettingsToConfigOptions);
  // That kind of "name" is exactly what we want to block and treat it as if it has not been found.
  const resolvedName = deps.providerName?.(parsed.providerId)?.trim();
  const providerName =
    resolvedName === undefined || resolvedName === parsed.providerId ? undefined : resolvedName;
  const name = formatProviderModelLabel(parsed.providerId, providerName, parsed.modelId);

  const rawLevel = parsed.options?.reasoningLevel;
  if (rawLevel === undefined) {
    return { canonical: trimmed, name };
  }
  // The gear words are in the same table as the thinking control; values ​​not in the table are displayed as they are (provider's customized gear name).
  const labelId = thoughtLevelLabelId(rawLevel);
  return {
    canonical: trimmed,
    level: labelId === undefined ? rawLevel : deps.formatMessage({ id: labelId }),
    name,
  };
}

/**
 * One line covering both model and level: with no level it is the model name itself (shared by the
 * confirmation dialog and the tooltip).
 */
export function workflowSubagentModelText(
  formatMessage: FormatMessage,
  label: WorkflowSubagentModelLabel,
): string {
  return label.level === undefined
    ? label.name
    : formatMessage(
        { id: "chat.toolCall.workflow.subagentModel.withLevel" },
        { level: label.level, model: label.name },
      );
}

/**
 * The tooltip shared by the three surfaces: a one-line explanation (where the subagent runs, the
 * main agent is unchanged) + a line break + the canonical string. The canonical string exists for
 * machines to backfill, so it belongs only here.
 */
export function workflowSubagentModelTooltip(
  formatMessage: FormatMessage,
  label: WorkflowSubagentModelLabel,
): string {
  const explained = formatMessage(
    { id: "chat.toolCall.workflow.subagentModel.tooltip" },
    { model: workflowSubagentModelText(formatMessage, label) },
  );
  return `${explained}\n${label.canonical}`;
}

/**
 * The two things the card and the side panel need: the name on screen (name only, the level is left
 * to the tooltip) and the tooltip. Absent when the run never specified a model — following the
 * session model is the norm and there is nothing to say about it.
 */
export function workflowSubagentModelCardLabel(
  canonical: string | undefined,
  deps: WorkflowSubagentModelDeps,
): { name: string; title: string } | undefined {
  if (canonical === undefined) {
    return undefined;
  }
  const label = describeWorkflowSubagentModel(canonical, deps);
  return { name: label.name, title: workflowSubagentModelTooltip(deps.formatMessage, label) };
}
