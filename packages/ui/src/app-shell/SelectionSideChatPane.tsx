import { memo, useCallback, useMemo } from "react";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { SelectionSideChatPaneTab } from "@/lib/workspaceSidePane.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import { SessionPane } from "@/v4/SessionPane.js";
import { V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";

export const SelectionSideChatPane = memo(function SelectionSideChatPane({
  tab,
  focused,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onOpenFileLink,
  onUnavailable,
}: {
  tab: SelectionSideChatPaneTab;
  focused: boolean;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onUnavailable: (tabId: string) => void;
}) {
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    }),
    [tab.remoteSessionId, tab.workspaceIdentity, tab.workspacePath],
  );
  // The parent tabs.map originally created inline closures for each memo pane, and any parent rendering would
  // Destroy the stability of the onUnavailable reference; close the callback by the leaf according to the stable tab id.
  const handleUnavailable = useCallback(() => onUnavailable(tab.id), [onUnavailable, tab.id]);
  return (
    <V4PaneConversationProvider scope={scope}>
      <SessionPane
        paneId={tab.id}
        sessionId={tab.childSessionId}
        openTrigger="selection"
        selectionSideChat
        focused={focused}
        telemetryVisible={focused}
        workspacePath={tab.workspacePath}
        workspaceIdentity={tab.workspaceIdentity}
        remoteSessionId={tab.remoteSessionId}
        onOpenBrowserUrl={onOpenBrowserUrl}
        onOpenCodeViewer={onOpenCodeViewer}
        onOpenFileLink={onOpenFileLink}
        onSelectionSideChatUnavailable={handleUnavailable}
      />
    </V4PaneConversationProvider>
  );
});
