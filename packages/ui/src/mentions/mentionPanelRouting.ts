import type { PromptInputTrigger } from "@/lib/promptInputTriggers.js";

export type MentionPanelGroupId = "plugins" | "files" | "sessions" | "whiteboards" | "skills";
export type SessionMentionWorkspaceScope = "current-workspace" | "same-authority-workspaces";

const CONTEXT_GROUP_ORDER: readonly MentionPanelGroupId[] = [
  "plugins",
  "files",
  "sessions",
  "whiteboards",
];
const SESSION_GROUP_ORDER: readonly MentionPanelGroupId[] = ["sessions"];
const SKILL_GROUP_ORDER: readonly MentionPanelGroupId[] = ["skills"];

/**
 * An input trigger is only responsible for surfacing the entry point; it does not change the
 * canonical mention after a candidate is selected. `#` and `$` (including the `¥` / `¥` normalized
 * by the input layer) keep the old single-group panel.
 */
export function getMentionPanelGroupOrder(
  trigger: PromptInputTrigger | null | undefined,
): readonly MentionPanelGroupId[] {
  if (trigger === "@") {
    return CONTEXT_GROUP_ORDER;
  }
  if (trigger === "#") {
    return SESSION_GROUP_ORDER;
  }
  if (trigger === "$") {
    return SKILL_GROUP_ORDER;
  }
  return [];
}

/**
 * `@` and `#` reuse the same session provider, but their product scope differs. If the workspace
 * were extended unconditionally inside the shared provider, `@` would be enlarged along with it;
 * the scope must be decided explicitly by the trigger's routing.
 */
export function getSessionMentionWorkspaceScope(
  trigger: PromptInputTrigger | null | undefined,
): SessionMentionWorkspaceScope {
  return trigger === "#" ? "same-authority-workspaces" : "current-workspace";
}
