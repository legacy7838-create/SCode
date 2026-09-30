// Session logging of GUI configuration changes.
// Enqueue the settings wheel into the runtime queue, record the from/to of the two settings, and distinguish between revisions that generate new runs and concurrent adjustments that take effect in place.
// Change decisions and side effect ordering are taken care of by dynamic-workflow-run-settings.ts.

import type { TraceContext, WorkflowSettingsAmendMeta } from "@zcode/contracts";
import type { DynamicWorkflowRunSnapshot } from "@zcode/contracts";
import { uuidv7 } from "@zcode/shared";
import { createRuntimeCommandId } from "../command-queue.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { boundWorkflowLaunchMeta } from "@zcode/contracts";

/** The normalized form of this run's two settings: absent means the default (session model / machine ceiling). */
export interface RunSettings {
  subagentModel?: string;
  maxConcurrency?: number;
}

/**
 * The settings turn is not landed directly in the command handler: the main agent may be
 * mid-turn and a user message cannot be inserted. It is queued on the runtime queue, runs
 * immediately when idle and waits for the current turn to end when busy; it shares priority
 * with notifications, so it precedes any notification of a new run.
 */
export function enqueueSettingsTurn(
  this: AgentRuntimeInternal,
  turn: {
    text: string;
    meta: ReturnType<typeof boundWorkflowLaunchMeta>;
    titleInput: string;
    traceContext: TraceContext;
  },
): void {
  this.enqueueRuntimeCommand({
    branchGeneration: this.branchGeneration,
    createdAt: new Date(),
    id: createRuntimeCommandId(),
    inputId: uuidv7(),
    mode: "control-only-turn",
    priority: "next",
    text: turn.text,
    titleInput: turn.titleInput,
    traceContext: turn.traceContext,
    workflowLaunch: turn.meta,
  });
}

export function fromTo<T>(from: T | undefined, to: T | undefined): { from?: T; to?: T } {
  return { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) };
}

/**
 * The canonical model-facing sentence of the settings turn (English, not localized — it goes
 * into the provider transcript). It mentions only the settings that changed; each of the two
 * `null`s has a sentence of its own. The last sentence discourages the model from touching
 * this run again: it is already running and its progress comes back as a notification.
 *
 * The two outcomes diverge here, and the criterion is exactly whether
 * `amend.predecessorRunId` is present (absent means it took effect in place, read the same
 * way as the metadata): an amendment produced a new run, whereas changing concurrency in
 * place is still the same run — written as an amendment sentence, the model would go looking
 * for a run B that does not exist at all.
 */
export function buildSettingsMessageText(input: {
  name?: string;
  previous: string;
  runId: string;
  superseded: boolean;
  amend: WorkflowSettingsAmendMeta;
}): string {
  const inPlace = input.amend.predecessorRunId === undefined;
  const lead = `Changed the settings of workflow run ${input.previous}${input.name === undefined ? "" : ` ("${input.name}")`} from the GUI: ${settingsChangeClauses(input.amend, inPlace).join("; ")}.`;
  const closing =
    "Progress and results arrive as background notifications; do not amend, resume or restart it.";
  if (inPlace) {
    const kept =
      input.amend.maxConcurrency?.to === undefined
        ? `Run ${input.previous} keeps running with no limit`
        : `Run ${input.previous} keeps running under the new limit`;
    return [lead, `${kept}; nothing was stopped and no new run was started.`, closing].join(" ");
  }
  const relation = input.superseded ? "supersedes" : "takes over from";
  return [
    lead,
    `The same script continues as run ${input.runId}, which ${relation} run ${input.previous} and imports everything run ${input.previous} finished as cache.`,
    closing,
  ].join(" ");
}

/**
 * The "what changed" clause. The in-place one has to spell out its subject ("at most n of
 * **its subagents**"): on that path no model clause precedes it, so "at most n of them" would
 * have no antecedent.
 */
function settingsChangeClauses(amend: WorkflowSettingsAmendMeta, inPlace: boolean): string[] {
  const changes: string[] = [];
  const model = amend.subagentModel;
  if (model !== undefined) {
    changes.push(
      model.to === undefined
        ? "its subagents are back on the session model"
        : `its subagents now run on ${model.to}`,
    );
  }
  const bound = amend.maxConcurrency;
  if (bound !== undefined) {
    changes.push(
      bound.to === undefined
        ? "the limit on subagents at once is removed"
        : inPlace
          ? `at most ${bound.to} of its subagents run at once`
          : `at most ${bound.to} of them run at once`,
    );
  }
  return changes;
}

/**
 * The two settings on the snapshot. Both are "absent when there is none": a model that was
 * never specified means the session model, and a bound that is not below the ceiling means
 * there is no bound of its own, so absent *is* the default — read exactly like
 * {@link RunSettings}.
 */
export function runSettingsOfSnapshot(snapshot: DynamicWorkflowRunSnapshot): RunSettings {
  return {
    ...(snapshot.subagentModel === undefined ? {} : { subagentModel: snapshot.subagentModel }),
    ...(snapshot.maxConcurrency === undefined ? {} : { maxConcurrency: snapshot.maxConcurrency }),
  };
}
