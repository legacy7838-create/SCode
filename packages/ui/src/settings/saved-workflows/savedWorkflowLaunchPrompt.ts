// Hub's "Create via Conversation/Revise in Conversation" pre-filled copy.
// They are ordinary user messages: only pre-filled drafts, not automatically sent, and the user then writes what they want to change/build.
// Exception for "promote to global" copy (buildSavedWorkflowPromotePrompt): it acts as createSession.firstInput
// **Automatically sent**, so the complete command instead of the beginning.

function isZh(locale: string): boolean {
  return locale.toLowerCase().startsWith("zh");
}

/**
 * "Revise in the conversation": prefill only, do not auto-send — the user goes on to write what to
 * change.
 */
export function buildSavedWorkflowRevisePrompt(input: {
  name: string;
  path: string;
  locale: string;
  scope?: "project" | "global";
}): string {
  // When revising the global file, add the sentence "Keep scope: "global"" to allow the model to fall back to the same file when overwritten and saved.
  const globalReminderZh =
    input.scope === "global" ? 'It is a global workflow; keep scope: "global" when saving. ' : "";
  const globalReminderEn =
    input.scope === "global" ? 'It is a global workflow; keep scope: "global" when saving. ' : "";
  return isZh(input.locale)
    ? `Please revise the saved workflow "${input.name}" (${input.path}): ${globalReminderZh}`
    : `Please revise the saved workflow "${input.name}" (${input.path}): ${globalReminderEn}`;
}

/** Empty state / top-bar "create through a conversation": prefill an opening. */
export function buildSavedWorkflowCreatePrompt(
  locale: string,
  scope?: "project" | "global",
): string {
  if (scope === "global") {
    return isZh(locale)
      ? 'Help me design a workflow and save it as a global workflow (scope: "global") with SaveWorkflow once it works: '
      : 'Help me design a workflow and save it as a global workflow (scope: "global") with SaveWorkflow once it works: ';
  }
  return isZh(locale)
    ? "Help me design a workflow and save it to this project once it works: "
    : "Help me design a workflow and save it to this project once it works: ";
}

/**
 * "Promote to global": condense the project profile into a complete instruction for the global
 * profile (auto-sent, not a prefilled opening).
 *
 * Give only the name and the path and let the model read the file itself. The checklist is
 * arbitrated by the user: read → find repository-specific references → abstract them into args or
 * neutral wording → keep the causal structure → SaveWorkflow(scope: "global", name can be changed)
 * → summarize; when something is inherently bound to the project, it is fine to say no. State
 * explicitly "do not modify the original file": having both copies coexist with the user deleting
 * one is the established boundary (invariant 9).
 */
export function buildSavedWorkflowPromotePrompt(input: {
  name: string;
  path: string;
  locale: string;
}): string {
  if (isZh(input.locale)) {
    return [
      `Promote the saved project workflow "${input.name}" (${input.path}) to a global workflow. Global workflows are visible to every project and can run from any of them, so it must not depend on anything in this repository. Follow these steps:`,
      "1. Read the file and understand its causal structure (which subagents, in what order, with what hand-offs).",
      "2. Find everything that refers to this repository: concrete paths, commands, directory layout, naming conventions, branch names, and so on.",
      "3. Lift those into `args` declarations (with descriptions and sensible defaults) or rewrite them in project-neutral terms, keeping the causal structure intact.",
      '4. Save it with SaveWorkflow using scope: "global". Keep the name or pick a better one. Do not modify the original project workflow file.',
      "5. Finish with a short summary of what you generalized and which points became arguments.",
      "If the workflow is inherently bound to this project and cannot be generalized meaningfully, say why and stop without saving.",
    ].join("\n");
  }
  return [
    `Promote the saved project workflow "${input.name}" (${input.path}) to a global workflow. Global workflows are visible to every project and can run from any of them, so it must not depend on anything in this repository. Follow these steps:`,
    "1. Read the file and understand its causal structure (which subagents, in what order, with what hand-offs).",
    "2. Find everything that refers to this repository: concrete paths, commands, directory layout, naming conventions, branch names, and so on.",
    "3. Lift those into `args` declarations (with descriptions and sensible defaults) or rewrite them in project-neutral terms, keeping the causal structure intact.",
    '4. Save it with SaveWorkflow using scope: "global". Keep the name or pick a better one. Do not modify the original project workflow file.',
    "5. Finish with a short summary of what you generalized and which points became arguments.",
    "If the workflow is inherently bound to this project and cannot be generalized meaningfully, say why and stop without saving.",
  ].join("\n");
}
