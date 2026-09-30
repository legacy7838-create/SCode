// ============================================================
// Three sentences on the model side of the script file
// ============================================================
//
// The tool response is one of three readers (the other two are final notifications and `GetWorkflowRun`), and the three readers want to push the model to the same
// Next step: **Go edit that file**. So just one thing to put here - know which file the script falls after, the diagnostic line with NOTE
// How to write. `CreateWorkflow` and `AmendWorkflow` share it, because "after changing the `path`, hand it back" in both tools
// The above is the same sentence. If written separately, it will branch into two sentences.
//
// When the file is unknown (a project that cannot be written in draft), there is no sentence here: the caller retains the old copy before the change, and the model still reads
// "Change the script and submit it again."

import type { CreateWorkflowDiagnostic } from "@zcode/contracts";

/**
 * The identity of the script file on the model-facing side. `kind` only affects one verb: `draft` is the copy
 * **the tool just wrote** ("saved at"), `path` is the file the model itself named ("The script file is") —
 * saying "saved at" about a file that already existed reads as if the tool had just touched it.
 */
export interface WorkflowScriptLocation {
  kind: "draft" | "path";
  /** The model-facing form (workspace-relative or absolute), computed by `describeWorkflowScriptPath`. */
  described: string;
  /** The offset from body line to file line; 0 when there is no metadata block. */
  lineOffset: number;
}

/**
 * The model-facing diagnostic line. With a file it is written `{path}:L{line}:C{column} {message}`, and the line number counts **file** lines — a number that
 * can be pasted straight into an `Edit` on that file. Without a file it falls back to the old `L:C` form (body lines).
 *
 * The `diagnostics` array and the display payload in the output do **not** change along with it: the transcript surface draws the body, and the body line is its coordinate.
 */
export function formatWorkflowDiagnosticLines(
  diagnostics: readonly CreateWorkflowDiagnostic[],
  location: WorkflowScriptLocation | undefined,
): string[] {
  if (location === undefined) {
    return diagnostics.map(
      (diagnostic) => `L${diagnostic.line}:C${diagnostic.column} ${diagnostic.message}`,
    );
  }
  return diagnostics.map(
    (diagnostic) =>
      `${location.described}:L${diagnostic.line + location.lineOffset}:C${diagnostic.column} ${diagnostic.message}`,
  );
}

/**
 * The NOTE for "does not compile" when the script has a file (both sources, inline and `path`). The last half
 * sentence is the whole point of this feature: **never paste the script again**.
 */
export function workflowScriptFileNote(location: WorkflowScriptLocation): string {
  const where =
    location.kind === "draft"
      ? `The script is saved at ${location.described}.`
      : `The script file is ${location.described}.`;
  return `NOTE: The workflow was NOT executed. ${where} Edit that file in place and resubmit with \`path: "${location.described}"\` — do not paste the script inline again.`;
}

/**
 * The NOTE for "does not compile" when the source is a saved definition. It says two extra things: **which definition this copy was taken from** (so the model knows
 * it is changing the copy, not the definition), and that changing the definition itself goes through `SaveWorkflow`. The arguments have to be passed
 * once more — the copy carries the metadata block and the declaration is still there, so a `path` submission validates them just the same.
 */
export function workflowSavedDraftNote(options: {
  savedName: string;
  savedPath: string;
  draft: string;
}): string {
  return `NOTE: The workflow was NOT executed. A working copy of the saved workflow '${options.savedName}' (${options.savedPath}) was written to ${options.draft}. Edit that copy in place and resubmit with \`path: "${options.draft}"\` (pass its \`args\` again); to change the saved definition itself, use SaveWorkflow.`;
}

/** The sentence appended after a successful launch: the next amendment starts by editing this file. */
export function workflowLaunchedScriptSentence(location: WorkflowScriptLocation): string {
  const where =
    location.kind === "draft"
      ? `The script is saved at ${location.described}`
      : `The script file is ${location.described}`;
  return ` ${where}; to revise it later, edit that file and pass \`path\` to AmendWorkflow.`;
}

/** The sentence appended after an amendment launches successfully (amending again is still the same action). */
export function workflowAmendedScriptSentence(location: WorkflowScriptLocation): string {
  return ` The revision's script is at ${location.described}; edit it there for a further revision.`;
}
