/**
 * **By-name** identification of the workflow tool family, merging three places that each carried
 * their own copy of the same matcher:
 * - reusable workflows: `SaveWorkflow` / `ListSavedWorkflows`;
 * - escalation questions: `escalate` / `ResolveWorkflowQuestion`;
 * - observation and resume: `GetWorkflowRun` / `ListWorkflowRuns` / `EvalWorkflowSnippet` and
 *   `ResumeWorkflowRun`;
 * - model catalog: `ListModels`.
 *
 * Why not go through `resolveToolCallIdentity`: none of these tool names are in `packages/shared`'s
 * `ZCODE_KNOWN_TOOL_NAMES`, so identity only ever answers `unknown` for them and routing falls into
 * the raw JSON fallback card.
 *
 * These checks also have to be ordered **before** family routing: the fallback branch of the
 * `workflow` family is the CreateWorkflow card (`resolveRenderer.ts`) and the run confirmation
 * block (`PermissionDialog.tsx`), so the moment someone registers these names into the workflow
 * family, saving and listing would silently render as "create workflow" — the save confirmation
 * dialog would even grow a causal graph and Refine options. Deciding by name first keeps both the
 * pre- and post-registration worlds consistent.
 */

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeToolToken(value: unknown): string {
  // Follow the same method as cron-create.tsx: erase the uppercase and lowercase characters and delimiters, `SaveWorkflow` / `save_workflow`
  // Both wire writing methods are hits.
  return typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]/gu, "") : "";
}

interface WorkflowToolNameSource {
  toolName?: string | null;
  kind?: string | null;
  title?: string | null;
  raw?: unknown;
}

function matchesToolName(source: WorkflowToolNameSource, token: string): boolean {
  const rawNames = isPlainRecord(source.raw)
    ? [source.raw.toolName, source.raw.tool_name, source.raw.name]
    : [];
  return [source.toolName, source.kind, source.title, ...rawNames].some(
    (value) => normalizeToolToken(value) === token,
  );
}

export function isSaveWorkflowToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "saveworkflow");
}

export function isListSavedWorkflowsToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "listsavedworkflows");
}

export function isEscalateToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "escalate");
}

export function isResolveWorkflowQuestionToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "resolveworkflowquestion");
}

export function isGetWorkflowRunToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "getworkflowrun");
}

export function isListWorkflowRunsToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "listworkflowruns");
}

export function isEvalWorkflowSnippetToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "evalworkflowsnippet");
}

export function isResumeWorkflowRunToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "resumeworkflowrun");
}

/**
 * Model catalog. The same kind of by-name check: `ListModels` is not in the known-tool table
 * either, and the fallback card would spread out that model-side text starting with a providerId
 * as-is.
 */
export function isListModelsToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "listmodels");
}

/**
 * Create entry point. Render routing still goes through the `workflow` family (its fallback is the
 * create card); this by-name check only serves readers that skip routing: the draft-number links
 * from compile feedback have to recognize every creation inside a row window, whereas the family
 * would also count revisions.
 */
export function isCreateWorkflowToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "createworkflow");
}

/**
 * Revise entry point. It **is registered** into the workflow family (the confirmation dialog picks
 * the run confirmation block by family), but tool rows still decide by name first: the same
 * create-workflow renderer swaps in revision wording, instead of letting the family fallback draw
 * it as an ordinary "create workflow" card.
 */
export function isAmendWorkflowToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "amendworkflow");
}
