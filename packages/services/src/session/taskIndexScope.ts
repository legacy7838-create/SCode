/**
 * Scope resolution for the task index.
 *
 * Split out of `taskIndexRepo.ts` only for the line budget; the logic is the repository's, and it
 * is the part most worth reading on its own.
 *
 * The identity rule is `workspaceIdentity?.trim() || workspacePath`, and it is applied **here**,
 * at the boundary, rather than inside the engine. That is deliberate: two paths can share an
 * identity, and if the wrapper and the engine each derived a key the two would occasionally
 * disagree about a scope — a task filed under a key nothing else queries is invisible, and
 * invisible is the hardest kind of broken.
 */
import { resolveWorkspaceKey } from "@zcode/shared";

/** A scope as callers supply it: a path, and optionally the identity that supersedes it. */
export interface TaskIndexScopeInput {
  workspacePath?: string;
  workspaceIdentity?: string;
}

/** The resolved key for one scope. */
export const keyOf = (scope: TaskIndexScopeInput): string =>
  resolveWorkspaceKey({
    workspacePath: scope.workspacePath ?? "",
    workspaceIdentity: scope.workspaceIdentity,
  });

/**
 * The resolved keys for a scope list, deduplicated with first-occurrence order and with the blank
 * ones dropped.
 *
 * Order is kept because it is the caller's list order, and a caller that scopes two workspaces
 * expects them back in the order it asked.
 */
export const keysOf = (
  scopes: Array<{ workspacePath: string; workspaceIdentity?: string }>,
): string[] => [...new Set(scopes.map(keyOf).filter((key) => key.trim().length > 0))];

/**
 * The engine's scope shape, with the identity key resolved.
 *
 * `workspaceIdentity` is **omitted** when the scope has none, rather than sent as `null`: the
 * engine distinguishes an absent identity from a path-derived one by the key, and two spellings of
 * "no identity" is one more thing to get wrong.
 */
export interface TaskEngineScope {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export const engineScopes = (
  scopes: Array<TaskIndexScopeInput & { workspacePurpose?: string }>,
): TaskEngineScope[] =>
  scopes.map((scope) => ({
    workspaceKey: keyOf(scope),
    workspacePath: scope.workspacePath ?? "",
    ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
  }));
