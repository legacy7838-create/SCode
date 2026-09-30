// ============================================================
// Set the two text of the wheel
// ============================================================
// A "configuration" leaves a record on both sides: the line above the run card in the transcription "Settings adjusted · Subagents changed to use X · Up to N
// Run simultaneously", and the two lines from → to under the context block "Adjust settings by you" on the details page. Reading the same piece of `amend` metadata from two places,
// Wording rules are written here only once. Pure function + injected formatMessage / providerName, the same as subagent-model-label.

import type { WorkflowSettingsAmendMeta } from "@zcode/shared/zcode-protocol-v4";
import {
  describeWorkflowSubagentModel,
  type WorkflowSubagentModelDeps,
} from "./subagent-model-label.js";

/**
 * The model's on-screen name: just the name (the tier is left to the tooltip), the same word as the
 * model segment on a run card.
 */
function modelName(canonical: string, deps: WorkflowSubagentModelDeps): string {
  return describeWorkflowSubagentModel(canonical, deps).name;
}

/**
 * The segments of the transcript row (excluding the leading "settings adjusted" and the trailing
 * timestamp): only the settings that changed are present, the model first and the limit after it. A
 * missing `to` on the limit, or one not below the ceiling, both read as "the limit was restored to
 * this machine's default".
 */
export function workflowSettingsChangeSegments(
  amend: WorkflowSettingsAmendMeta,
  deps: WorkflowSubagentModelDeps,
): string[] {
  const { formatMessage } = deps;
  const segments: string[] = [];
  if (amend.subagentModel !== undefined) {
    const to = amend.subagentModel.to;
    segments.push(
      to === undefined
        ? formatMessage({ id: "chat.toolCall.workflow.settingsChange.modelSession" })
        : formatMessage(
            { id: "chat.toolCall.workflow.settingsChange.model" },
            { model: modelName(to, deps) },
          ),
    );
  }
  if (amend.maxConcurrency !== undefined) {
    const to = amend.maxConcurrency.to;
    const atCeiling = to === undefined || (amend.ceiling !== undefined && to >= amend.ceiling);
    segments.push(
      atCeiling
        ? formatMessage({ id: "chat.toolCall.workflow.settingsChange.limitCeiling" })
        : formatMessage({ id: "chat.toolCall.workflow.settingsChange.limit" }, { n: to }),
    );
  }
  return segments;
}

export interface WorkflowSettingsProvenanceRow {
  key: "model" | "limit";
  label: string;
  /** "{from} → {to}". */
  value: string;
}

/**
 * The from → to rows of the detail page's provenance block. A missing end is written as the
 * default: the model writes "session model", the limit writes this machine's limit (with the number
 * when the ceiling is known, e.g. "13 (machine limit) → 4").
 */
export function workflowSettingsProvenanceRows(
  amend: WorkflowSettingsAmendMeta,
  deps: WorkflowSubagentModelDeps,
): WorkflowSettingsProvenanceRow[] {
  const { formatMessage } = deps;
  const rows: WorkflowSettingsProvenanceRow[] = [];
  if (amend.subagentModel !== undefined) {
    const end = (canonical: string | undefined) =>
      canonical === undefined
        ? formatMessage({ id: "chat.workflowLaunch.settings.sessionModel" })
        : modelName(canonical, deps);
    rows.push({
      key: "model",
      label: formatMessage({ id: "chat.workflowLaunch.settings.model" }),
      value: `${end(amend.subagentModel.from)} → ${end(amend.subagentModel.to)}`,
    });
  }
  if (amend.maxConcurrency !== undefined) {
    const ceiling = amend.ceiling;
    const end = (bound: number | undefined) =>
      bound !== undefined && (ceiling === undefined || bound < ceiling)
        ? String(bound)
        : ceiling === undefined
          ? formatMessage({ id: "chat.workflowLaunch.settings.machineLimit" })
          : formatMessage({ id: "chat.workflowLaunch.settings.machineLimitValue" }, { n: ceiling });
    rows.push({
      key: "limit",
      label: formatMessage({ id: "chat.workflowLaunch.settings.limit" }),
      value: `${end(amend.maxConcurrency.from)} → ${end(amend.maxConcurrency.to)}`,
    });
  }
  return rows;
}
