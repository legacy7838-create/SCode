// ============================================================
// "Configuration" pure rules of elastic layer
// ============================================================
// The elastic layer component is only responsible for drawing and wiring. Here are all its judgments: which runs can be matched, where the form starts, what to apply,
// What does a rejected ACK say? Pure functions, without touching the store, can be enumerated one by one.

import {
  WORKFLOW_RUN_SETTINGS_REJECTED_FAULT_PREFIX,
  workflowRunSettingsRejectionReasonSchema,
  type AmendWorkflowRunSettingsPayload,
  type CommandAck,
  type WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";
import { formatModelPickerValue, parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";

/**
 * The session's current model (the "Session model" entry is named after it): prefers the session's
 * persisted sparse selection and falls back to the UI-effective provider / model projection; if
 * neither can be read it is absent.
 */
export function workflowSessionModelOf(
  config:
    | { modelSelection?: { providerId: string; modelId: string }; provider: string; model: string }
    | null
    | undefined,
): { providerId: string; modelId: string } | undefined {
  if (config === null || config === undefined) return undefined;
  const selection = config.modelSelection;
  if (selection !== undefined)
    return { providerId: selection.providerId, modelId: selection.modelId };
  const providerId = config.provider.trim();
  const modelId = config.model.trim();
  return providerId && modelId ? { providerId, modelId } : undefined;
}

/**
 * The subagent model in the form: the session model, or a specific model (optionally with a thought
 * level).
 */
export type WorkflowRunSettingsModel =
  | { kind: "session" }
  | { kind: "model"; providerId: string; modelId: string; level?: string };

/**
 * The form's two settings. A `bound` of null means "this run has no limit of its own" (it runs at
 * the machine-wide limit).
 */
export interface WorkflowRunSettingsDraft {
  model: WorkflowRunSettingsModel;
  bound: number | null;
}

/** The part of the payload Apply sends out (workId is filled in by the host). */
export type WorkflowRunSettingsChange = Omit<AmendWorkflowRunSettingsPayload, "workId">;

/**
 * Which runs can be configured: pending / running can (throttling or switching models is the main
 * scenario); stopped can, unless it was superseded by a revision (its successor is the live one);
 * errored can (retrying with a different model is the most common fix); completed cannot (every ask
 * is replayed from cache, so nothing will run under the new settings); a run missing from the
 * projection has no settings to show. The host callback and the staged-rollout gate are layered on
 * by the caller.
 */
export function isWorkflowRunConfigurable(run: WorkflowRunState | undefined): boolean {
  if (run === undefined) return false;
  switch (run.status) {
    case "pending":
    case "running":
    case "errored":
      return true;
    case "stopped":
      return run.supersededBy === undefined && run.stopReason !== "superseded";
    case "completed":
      return false;
  }
}

/**
 * The machine-wide concurrency ceiling: prefers `run.concurrencyCeiling` (always carried by
 * `run-started`), and falls back to the readout chip's own waterline `concurrency.ceiling` when an
 * older CLI does not send it. With neither, it is unknown — the stepper has no upper bound and
 * writes no hint.
 */
export function workflowRunSettingsCeiling(run: WorkflowRunState): number | undefined {
  return run.concurrencyCeiling ?? run.concurrency?.ceiling;
}

/**
 * Canonical string → form model; if it cannot be parsed (a bad string) there is no basis for
 * treating it as the session model, so it is kept verbatim as a specific model that resolves to
 * nothing.
 */
export function workflowRunSettingsModelOf(
  canonical: string | undefined,
): WorkflowRunSettingsModel {
  const text = canonical?.trim();
  if (!text) return { kind: "session" };
  try {
    const parsed = parseModelPickerValue(text);
    const level = parsed.options?.reasoningLevel;
    return {
      kind: "model",
      providerId: parsed.providerId,
      modelId: parsed.modelId,
      ...(level === undefined ? {} : { level }),
    };
  } catch {
    return { kind: "model", providerId: "", modelId: text };
  }
}

/**
 * Form model → canonical string `providerId/modelId[$level]`; the session model has no string
 * (undefined).
 */
export function workflowRunSettingsModelCanonical(
  model: WorkflowRunSettingsModel,
): string | undefined {
  if (model.kind === "session") return undefined;
  if (model.providerId === "") return model.modelId;
  return formatModelPickerValue({
    providerId: model.providerId,
    modelId: model.modelId,
    ...(model.level === undefined ? {} : { options: { reasoningLevel: model.level } }),
  });
}

/**
 * The starting point when the popover opens: both items take the run's own current settings. With
 * the limit absent it rests at the ceiling (null when the ceiling is unknown too).
 */
export function initialWorkflowRunSettingsDraft(run: WorkflowRunState): WorkflowRunSettingsDraft {
  const limit = run.concurrency?.limit;
  return {
    model: workflowRunSettingsModelOf(run.subagentModel),
    bound: limit ?? workflowRunSettingsCeiling(run) ?? null,
  };
}

/** Normalization of the limit: reaching or exceeding the ceiling means "no limit of its own". */
function normalizedBound(bound: number | null, ceiling: number | undefined): number | null {
  if (bound === null) return null;
  return ceiling !== undefined && bound >= ceiling ? null : bound;
}

/**
 * What Apply sends: only the items that **changed** (the same tri-state discipline as the tool's:
 * omitted = keep). The model is compared as a canonical string — changing only the thought level
 * still counts as a model change; switching back to the session model sends `null`. A limit equal
 * to the ceiling sends `null` (dropping this run's own limit). If neither item changed → undefined
 * (Apply is disabled).
 */
export function workflowRunSettingsChange(
  initial: WorkflowRunSettingsDraft,
  draft: WorkflowRunSettingsDraft,
  ceiling: number | undefined,
): WorkflowRunSettingsChange | undefined {
  const change: WorkflowRunSettingsChange = {};
  const fromModel = workflowRunSettingsModelCanonical(initial.model);
  const toModel = workflowRunSettingsModelCanonical(draft.model);
  if (fromModel !== toModel) change.subagentModel = toModel ?? null;
  const fromBound = normalizedBound(initial.bound, ceiling);
  const toBound = normalizedBound(draft.bound, ceiling);
  if (fromBound !== toBound) change.maxConcurrency = toBound;
  return Object.keys(change).length === 0 ? undefined : change;
}

/** Stepper clamping: lower bound 1, upper bound the ceiling (no upper bound when it is unknown). */
export function clampWorkflowRunSettingsBound(value: number, ceiling: number | undefined): number {
  const floor = Math.max(1, Math.floor(value));
  return ceiling === undefined ? floor : Math.min(floor, ceiling);
}

/**
 * Only the concurrency ceiling changed (`null` = dropping this run's own limit, which counts too).
 * The criterion is that the payload contains **only** this one key — the same rule as the
 * agent-side routing: it too recognizes just this one payload shape, and one extra field falls back
 * to the original revision.
 */
function isConcurrencyOnlyChange(change: WorkflowRunSettingsChange | undefined): boolean {
  if (change === undefined) return false;
  return Object.keys(change).length === 1 && change.maxConcurrency !== undefined;
}

/**
 * The copy key for the consequence sentence: the final sentence changes with the run state
 * (completed never reaches here).
 *
 * Changing only the concurrency ceiling of a **running** run takes effect in place, without
 * stopping it or starting another run, so the consequence of the concurrency adjustment is shown
 * here. `pending` is not included: its engine may not have been built yet, and if the in-place
 * change does not take, it falls back as usual to a real revision, where the original sentence is
 * still correct.
 */
export function workflowRunSettingsConsequenceId(
  status: WorkflowRunState["status"],
  change?: WorkflowRunSettingsChange,
): string {
  if (status === "running" && isConcurrencyOnlyChange(change))
    return "chat.toolCall.workflow.run.settings.consequence.concurrencyLive";
  switch (status) {
    case "pending":
      return "chat.toolCall.workflow.run.settings.consequence.pending";
    case "stopped":
      return "chat.toolCall.workflow.run.settings.consequence.stopped";
    case "errored":
      return "chat.toolCall.workflow.run.settings.consequence.errored";
    default:
      return "chat.toolCall.workflow.run.settings.consequence.running";
  }
}

/**
 * The same capability-absent fault as Stop / Resume (the gateway's reasonCode for
 * V4CapabilityUnsupportedError).
 */
const CAPABILITY_UNSUPPORTED_FAULT = "fault.command.capabilityUnsupported";
const KNOWN_REASONS: ReadonlySet<string> = new Set(
  workflowRunSettingsRejectionReasonSchema.options,
);

export interface WorkflowRunSettingsRejection {
  /**
   * A reason from the vocabulary, or `unsupported` (capability absent) / `generic` (outside the
   * vocabulary, the copy carries the code).
   */
  reason: string;
  /** The raw reasonCode (ack.status when absent). */
  code: string;
  /**
   * Human-readable details carried by the ACK (bounded diagnostics for compile_failed, the reason
   * for start_failed).
   */
  message?: string;
}

/**
 * accepted / noop are not rejections → undefined; the rest reverse-look-up the vocabulary by the
 * fault prefix.
 */
export function describeWorkflowRunSettingsRejection(
  ack: Pick<CommandAck, "status" | "reasonCode" | "message">,
): WorkflowRunSettingsRejection | undefined {
  if (ack.status === "accepted" || ack.status === "noop") return undefined;
  const code = ack.reasonCode ?? ack.status;
  let reason = "generic";
  if (ack.reasonCode === CAPABILITY_UNSUPPORTED_FAULT) reason = "unsupported";
  else if (ack.reasonCode?.startsWith(WORKFLOW_RUN_SETTINGS_REJECTED_FAULT_PREFIX)) {
    const suffix = ack.reasonCode.slice(WORKFLOW_RUN_SETTINGS_REJECTED_FAULT_PREFIX.length);
    if (KNOWN_REASONS.has(suffix)) reason = suffix;
  }
  return { reason, code, ...(ack.message ? { message: ack.message } : {}) };
}

/** Copy key: `chat.toolCall.workflow.run.settings.rejection.<reason>`. */
export function workflowRunSettingsRejectionMessageId(
  rejection: WorkflowRunSettingsRejection,
): string {
  return `chat.toolCall.workflow.run.settings.rejection.${rejection.reason}`;
}

/**
 * Whether the details block is given: the start_failed reason is already embedded in that sentence
 * (`{message}`) and is not repeated; other rejections that carry a message (the compile_failed
 * diagnostics) go into a bounded monospace block.
 */
export function workflowRunSettingsRejectionDetail(
  rejection: WorkflowRunSettingsRejection,
): string | undefined {
  return rejection.reason === "start_failed" ? undefined : rejection.message;
}
