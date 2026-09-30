import { useCallback } from "react";
import type { IServiceAccessor } from "@zcode/services";
import { TerminalSession } from "@/terminal/TerminalSession.js";

export function SidePaneTerminalPane({
  services,
  sessionId,
  workspaceKey,
  cwd,
  isVisible,
  isWindowsDesktop = false,
  onOpenBrowserUrl,
}: {
  services: IServiceAccessor;
  /**
   * Keep alive: sessionId reuses tab.id (stable across workspaces) and serves as the persistentKey of TerminalSession.
   * Let xterm+PTY ownership go into the sidePaneTerminalSessionRegistry module-level singleton,
   * When components are uninstalled, they are only detachable and not disposed; when remounted, they are reused by key, and scrollback is kept alive across workspaces.
   */
  sessionId: string;
  /**
   * workspace identity isolation key (= workspaceIdentity?.trim() || workspacePath).
   * Write registry entry.workspaceKey and press this to recycle PTY in batches when the workspace tab is closed.
   */
  workspaceKey?: string;
  cwd?: string;
  isVisible: boolean;
  isWindowsDesktop?: boolean;
  onOpenBrowserUrl: (url: string) => void;
}) {
  const handleShellLabelChange = useCallback(() => {
    // Business description: The outer tab of the side pane already carries the terminal title. Only a single shell instance is needed here.
    // The second-level terminal tab titles are no longer displayed or synchronized to avoid nested tabs.
  }, []);

  return (
    <section className="h-full min-h-0 overflow-hidden bg-background p-3">
      <TerminalSession
        sessionId={sessionId}
        persistentKey={sessionId}
        workspaceKey={workspaceKey}
        services={services}
        cwd={cwd}
        isVisible={isVisible}
        isWindowsDesktop={isWindowsDesktop}
        onShellLabelChange={handleShellLabelChange}
        onOpenBrowserUrl={onOpenBrowserUrl}
      />
    </section>
  );
}
