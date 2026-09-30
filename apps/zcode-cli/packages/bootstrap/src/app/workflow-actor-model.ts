// ============================================================
// Model face of workflow actor (run selection/journal pin → AgentRuntime model configuration)
// ============================================================
//
// persona's model level (`model?: "main" | "lite"`) has been retired. The host does not have a lite model source after the provider is refactored.
// "lite" and "main" already share the same path - inherit the current model of the parent session.
//
// So this module only answers one question: **Which model should this actor's session run on**. Three sources in order of priority:
// `subagentModel` of this run (`subagent_model` of `CreateWorkflow` / `AmendWorkflow`) > resume pin (the last model actually run in the journal) > current model of the parent session.
// It is a sister module on the same seam as workflow-actor-tools.ts: one gives the tool surface, the other gives the model surface,
// They are all expanded by the runtime factory on the driver side when creating AgentRuntime.

import type { ModelSelection } from "@zcode/shared/model-selection";
import { parseProviderQualifiedModelSelection } from "./provider-registry-selection.js";

/** Host-side facts needed to resolve the model surface. */
interface WorkflowActorModelHost {
  /**
   * The parent session's **current** model selection (`runtime.getSessionModelSelection()`). It is only
   * useful when there is no run-level selection: to compare it against the pin (deciding whether "the pinned model
   * is exactly the current main model", and hence whether the pin branch really has to override). Absent while the
   * parent session has no selection yet.
   */
  parentSelection?: ModelSelection | undefined;
  /**
   * This run's own subagent model (`subagent_model` of `CreateWorkflow` / `AmendWorkflow`, read back from the
   * journal's `run-launched` event). The **entire selection**, including the reasoning
   * tier -- when the user says "run the subagent on GLM-5.3-Flash$high" that tier is part of the selection and must
   * not be dropped here.
   *
   * Position: **highest**. It is the user's explicit statement for this one run; when present, the pin and the parent
   * model are only the defaults it was meant to replace (see the function comment below). The main agent is unaffected -- it describes subagents only.
   */
  runSelection?: ModelSelection | undefined;
}

/** Model-surface slice of AgentRuntimeConfig. */
interface WorkflowActorModelPolicy {
  /**
   * The overrides expanded into AgentRuntimeConfig. **An empty object means "no override"**: the baseline of the
   * child runtime is already the parent session's model selection (script-workflow-child-runtime.ts), so when there is
   * neither a run selection nor a pin nothing is written, i.e. the parent model is inherited.
   */
  configOverrides: {
    modelSelection?: ModelSelection;
  };
}

/**
 * Thrown when the pinned model cannot be constructed. It carries the pin itself: whoever debugs it needs to know
 * which model the journal pinned, instead of guessing from a generic "invalid model reference" message.
 */
export class WorkflowActorPinnedModelError extends Error {
  readonly pinnedModel: string;

  constructor(pinnedModel: string, cause?: unknown) {
    super(`Cannot construct the model pinned for this subagent: ${pinnedModel}`);
    this.name = "WorkflowActorPinnedModelError";
    this.pinnedModel = pinnedModel;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/**
 * Maps the run selection and the pin recorded in the journal into the model configuration of the AgentRuntime. A pure function.
 *
 * `pinnedModel` is the `resolvedModel` (`providerId/modelId`) this actor recorded in the journal, and only a resume
 * carries it (including the seed an amend-resume inherits from the predecessor).
 *
 * Priority: **this run's `subagentModel` > the resume pin > the parent session's current model**.
 *
 * | run selection | pin | resolution result |
 * |---|---|---|
 * | present | any (including malformed, not resolved) | override with the run selection (the whole thing, including the reasoning tier) |
 * | absent | absent | no override (the parent session's current model) |
 * | absent | = the parent session's current model | no override (what is pinned is exactly the current main model) |
 * | absent | ≠ the parent session's current model | override with the selection resolved from the pin |
 * | absent | malformed (missing the provider segment) | {@link WorkflowActorPinnedModelError} |
 *
 * **Omission means inheritance, an explicit value means replacement.** `resolveInput` for resume / amend already follows this rule for
 * `subagentModel` and `max_concurrency`; the pin is the same rule applied to an **implicit default**: for a run without
 * `subagentModel` the subagent default is not "the parent session's current model" but "the model this subagent actually ran on last time".
 * Once a run has a `subagentModel` there is no default left to inherit and the pin has nothing to say. So the pin sits below the run
 * selection -- it guards against silent drift, whereas `AmendWorkflow` carrying `subagent_model` is exactly the explicit, user-visible decision
 * (the confirmation dialog and the tool output both say "Subagents run on ..."). Pin used to sit above the run selection, which made
 * every resumed subagent with live work run on its predecessor's model while `run-launched` and the confirmation dialog said something else.
 * The model-change history is not lost: the new run's own `dwf_actor` row records the new selection and the predecessor's row still
 * holds the old model, so the lineage preserves "at which run it was switched".
 *
 * Why a pin is needed -- it is the persistence half of the **persona freeze invariant**: the persona is frozen at
 * `agent()`, and a resume rebuilds the actor from the journal. Without a pin, a parent session that switched its main model between two runs would
 * quietly **swap a frozen identity mid-transcript**: the first half of the asks comes from model X and the post-resume half from model Y, with
 * nothing anywhere recording that the identity changed.
 *
 * **v1's pin-miss policy (the path with no run selection): rather fail than silently switch models.** When the pin points at a model the
 * host can no longer construct (the provider is gone, the model is retired), this function does **not** fall back to the parent session's model -- that
 * is precisely the silent identity change the pin exists to prevent. A malformed pin fails here as a {@link WorkflowActorPinnedModelError}; and a model that is
 * "syntactically valid but no longer present on the host" cannot be detected at session-creation time (detecting it requires querying the host's Registry, the
 * machinery this pure function deliberately does not pull in) -- it surfaces as a node-level error on the model call of the **first ask**: this is accepted
 * on purpose: failing loudly a little later beats quietly swapping in a different model and continuing. If you want to change the model on resume, there is
 * exactly one road: `AmendWorkflow` with `subagent_model`, which is the run-selection branch.
 *
 * This function does **not** produce the fact of "which model actually ran": it has to land in the journal, and the authority is the child
 * runtime that was actually constructed (`runtime.getSessionModelSelection()`). Letting the runtime speak removes the kind of divergence that
 * only comes from computing it in two places ("the policy thought it picked A while the runtime actually runs B"). The write to the store
 * is in `journalActorResolvedModel` in dynamic-workflow-run-launch.ts.
 */
export function workflowActorModelPolicy(
  host: WorkflowActorModelHost,
  pinnedModel?: string,
): WorkflowActorModelPolicy {
  // The run selection is present: the entire line is covered, and the pin is not even parsed - it is just the default that this run will replace.
  if (host.runSelection !== undefined) {
    return { configOverrides: { modelSelection: host.runSelection } };
  }
  if (pinnedModel === undefined) return { configOverrides: {} };
  const pinned = parsePinnedModel(pinnedModel);
  // What is nailed is the current model of the parent session: the baseline left to the child runtime expresses itself. "No coverage" is **stronger**
  // Expression-baseline inherits along with the reasoning option, while overriding by identity replaces the option with an equivalent without the options.
  if (host.parentSelection !== undefined && sameModelIdentity(pinned, host.parentSelection)) {
    return { configOverrides: {} };
  }
  // The parent session changed master models between runs. Still pinning the pin - silently changing models is exactly what pins are designed to prevent;
  // Use AmendWorkflow's subagent_model (the one above).
  // The reasoning option is not recalculated on this path: the pin holds the **model identity** (providerId/modelId), and only these two paragraphs are recorded in the journal.
  return { configOverrides: { modelSelection: pinned } };
}

/** Pin comparison only looks at the two identity segments: the journal records `providerId/modelId`, options are not part of the identity. */
function sameModelIdentity(a: ModelSelection, b: ModelSelection): boolean {
  return a.providerId === b.providerId && a.modelId === b.modelId;
}

/**
 * Resolves the pin recorded in the journal. **No default provider**: the pin is a `providerId/modelId` written on this
 * machine, and a missing provider segment means the record was not written in that format (or was modified), so filling
 * it with the parent session's provider amounts to guessing a new identity -- exactly what the pin exists to prevent. Fail loudly.
 */
function parsePinnedModel(pinnedModel: string): ModelSelection {
  const parsed = parseProviderQualifiedModelSelection(pinnedModel);
  if (parsed === undefined) throw new WorkflowActorPinnedModelError(pinnedModel);
  return parsed;
}
