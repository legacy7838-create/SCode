// ============================================================
// Display tag of workflow run (derived when reading, never written back to dwf_run.name)
// ============================================================
//
// Two reasons for independent modules:
//   1. **Two reading surfaces share the same chain**. List (ListWorkflowRuns) and details (GetWorkflowRun) are spelled once each
//      If you don't know the bottom line, it will drift on a certain branch, and the symptom is that the same run displays different names in two places.
//   2. **can be directly tested**. run service drags a whole dependency chain of AgentRuntime/engine/journal;
//      A pure function shouldn't have to pay that price to be asserted.

import type { DynamicWorkflowRunSummary } from "@zcode/contracts";

/**
 * Character limit for a script-derived label. 80 is a length a list row can be read at a glance; a derived value is a heuristic, and the longer it is the less it looks like a label.
 */
const DYNAMIC_WORKFLOW_RUN_LABEL_MAX_CHARS = 80;

/**
 * Display label for a derived run: `name` → the script's first non-empty line (trimmed, capped at 80) → runId.
 *
 * Deliberately no "smarter" extraction (first comment, a regex to find a title, pulling the agent
 * name): the first line is **honest** ("the script starts with this"), and every heuristic added
 * is one more way to produce a misleading label on someone else's script.
 *
 * The derived result is **never** written back to `dwf_run.name`: persisting it amounts to freezing a display heuristic into data, after which even "does this run actually have a name" is unanswerable.
 */
export function resolveDynamicWorkflowRunLabel(input: {
  runId: string;
  name?: string;
  scriptText?: string;
}): Pick<DynamicWorkflowRunSummary, "label" | "labelSource"> {
  // A completely blank name is equivalent to no name: it is a line of unclickable blank space in the list, not a label.
  const name = input.name?.trim();
  if (name !== undefined && name.length > 0) return { label: name, labelSource: "name" };

  const firstLine = firstNonEmptyLine(input.scriptText);
  if (firstLine !== undefined) {
    return { label: boundLabel(firstLine), labelSource: "script" };
  }

  // Theoretically it won't happen (submit must bring scriptText). labelSource still reports "script" - the only thing the tool needs to distinguish is
  // There are two types of "name given by the user" and "named by us". Adding a source value to a branch that should not occur will only make the consumer
  // Write one more judgment that will never hit.
  return { label: input.runId, labelSource: "script" };
}

/** The first non-empty line (already trimmed). Returns undefined when the whole block is whitespace. */
function firstNonEmptyLine(scriptText: string | undefined): string | undefined {
  if (scriptText === undefined) return undefined;
  for (const line of scriptText.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

/**
 * Truncation to the limit, and never leaving a lone surrogate behind. Scripts are external input written by a model,
 * so string literals can contain emoji; half a surrogate pair is neither valid text nor accepted by downstream JSON
 * codecs on some runtimes (the same handling as boundGraphText in create-workflow and the bounding of port payloads).
 */
function boundLabel(value: string): string {
  if (value.length <= DYNAMIC_WORKFLOW_RUN_LABEL_MAX_CHARS) return value;
  const cut = value.slice(0, DYNAMIC_WORKFLOW_RUN_LABEL_MAX_CHARS);
  const lastCode = cut.charCodeAt(cut.length - 1);
  const isHighSurrogate = lastCode >= 0xd800 && lastCode <= 0xdbff;
  return isHighSurrogate ? cut.slice(0, -1) : cut;
}
