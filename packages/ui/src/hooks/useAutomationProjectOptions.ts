import { useMemo } from "react";
import type { WorkspacePurpose } from "@zcode/shared";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab, type WorkspaceTabState } from "@/store/tabStore.js";
import { useLocalWorkspaceScopes } from "@/hooks/useLocalWorkspaceScopes.js";

interface AutomationProjectOption {
  workspacePath: string;
  label: string;
  workspacePurpose?: WorkspacePurpose;
}

export function isRemoteAutomationWorkspace(tab: WorkspaceTabState | undefined): boolean {
  return Boolean(tab?.remoteSessionId || tab?.remoteTarget || tab?.workspaceIdentity);
}

interface AutomationProjectOptionsConfig {
  includeConversationWorkspace?: boolean;
}

function resolveAutomationProjectOptions(
  workspaceTabs: WorkspaceTabState[],
  config: AutomationProjectOptionsConfig = {},
): AutomationProjectOption[] {
  const result: AutomationProjectOption[] = [];
  let conversationWorkspaceIncluded = false;

  for (const tab of workspaceTabs) {
    if (tab.availability === "unavailable-local-directory") continue;

    if (tab.workspacePurpose === "conversation") {
      if (!config.includeConversationWorkspace || conversationWorkspaceIncluded) {
        continue;
      }
      // Historical settings may have multiple conversation backing paths remaining, but they all represent the same
      // "No project session" logical target. Retain purpose instead of relying on default copywriting recognition so that menus can be reused
      // Fixed text and icon for "not working in the project" on the session side, while still only binding one canonical cwd.
      conversationWorkspaceIncluded = true;
      result.push({
        workspacePath: tab.workspacePath,
        label: "default",
        workspacePurpose: "conversation",
      });
      continue;
    }

    result.push({
      workspacePath: tab.workspacePath,
      label: tab.label || workspaceBasename(tab.workspacePath),
    });
  }

  return result;
}

/**
 * Automation creation reads only the local workspaces that are already open in the current window
 * and still usable. Scheduled tasks may explicitly add one "no-project session" logical target;
 * idle-time tasks stay restricted to real projects.
 *
 * Candidates keep only usable local workspace tabs, excluding recent projects and remote tabs, so a
 * remote identity is never handed to a local host, and idle-time tasks never inherit a remote
 * workspace. Both task kinds share the entry filtering rule, keeping the project-isolation
 * semantics consistent.
 */
export function useAutomationProjectOptions(
  config: AutomationProjectOptionsConfig = {},
): AutomationProjectOption[] {
  const tabs = useTabStore((state) => state.tabs);
  const workspaceTabs = useMemo(() => tabs.filter(isWorkspaceTab), [tabs]);
  const localWorkspaceTabs = useLocalWorkspaceScopes({ workspaceTabs });
  const includeConversationWorkspace = config.includeConversationWorkspace === true;

  return useMemo(
    () =>
      resolveAutomationProjectOptions(localWorkspaceTabs, {
        includeConversationWorkspace,
      }),
    [includeConversationWorkspace, localWorkspaceTabs],
  );
}

function workspaceBasename(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path;
}
