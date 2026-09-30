// sidePaneTerminalSessionRegistry - A module-level singleton that keeps side pane terminal alive across workspace sessions.
//
// If xterm, PTY and subscription are held by TerminalSession component, uninstall triggered by switching workspace
// The process will be closed and the history will be lost. These resources are held by the module-level registry, and the component is only responsible for mounting and displaying.
// Terminal sessions can be kept alive across workspace switches.
//
// Repair ideas (symmetry of the lower side of the idea, but different forms):
//   Move the ownership of the side pane terminal's xterm instance + PTY association up to this module-level singleton,
//   Get out of the TerminalSession component effect life cycle. The component will not move when uninstalling or reinstalling xterm/PTY.
//   When re-hanging, press persistentKey(=tab.id) to retrieve the entry and physically move hostEl back to the container.
//
// Do not share the session with the lower terminal.
// Only SidePaneTerminalPane is accessed through the persistentKey prop of TerminalSession; persistentKey is not passed on the lower side.
// Taking the original effect path of TerminalSession has nothing to do with the registry.

import type { FitAddon } from "@xterm/addon-fit";
import type { ITheme, Terminal as XTerm } from "@xterm/xterm";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

/**
 * The long-lived resources of one side pane terminal session.
 *
 * - term/fitAddon: the xterm instance (including the scrollback history) + the fit addon; the same
 *   instance is reused across workspaces.
 * - terminalId: the PTY id assigned by terminalService (a root-level shared service; local
 *   workspaces share baseServices).
 * - hostEl: the long-lived container term.open renders into. It is physically moved between
 *   stashDiv (hidden staging) and the real render container, and the xterm DOM subtree moves with
 *   it, while the term instance and scrollback stay unchanged.
 * - dispose: the real teardown (called when the tab is closed) — kill the PTY + destroy xterm +
 *   release subscriptions. Injected by the TerminalSession creator, so the registry itself does not
 *   depend on terminalService (services are dependency-injected, not hardcoded here).
 */
export interface SidePaneTerminalSessionEntry {
  key: string;
  term: XTerm;
  fitAddon: FitAddon;
  terminalId: string;
  cwd: string;
  /**
   * The workspaceKey this terminal belongs to (= workspaceIdentity?.trim() || workspacePath). Used
   * only for bulk teardown by workspaceKey when a workspace tab is truly closed (the mirror of the
   * openWorkspaceKeys teardown on the other side). Switching workspaces does not trigger a
   * teardown; it only happens once that workspace is removed from openWorkspaceKeys.
   */
  workspaceKey: string;
  hostEl: HTMLDivElement;
  /**
   * The terminal profile theme returned by terminalService.create() (the colors from the user's
   * terminal settings). Bug context: the original implementation only wrote to a component-local
   * terminalProfileThemeRef, which is destroyed when the component unmounts; on remount the new
   * component's ref is reset to undefined, and the reused observer merges that undefined into the
   * base theme, dropping the profile theme. Ownership was moved up to the entry so that the profile
   * theme has the same long-lived owner as the term/PTY and is not lost when reused across
   * component lifecycles.
   */
  profileTheme?: ITheme;
  /**
   * The real dispose: kill the PTY + destroy xterm + release subscriptions + remove hostEl.
   * Injected by the creator (the TerminalSession persistentKey path).
   */
  dispose: () => void;
}

// Module-level state: resident across workspaces and React component trees.
const sessions = new Map<string, SidePaneTerminalSessionEntry>();
// Memory diagnostic counter: There is no upper limit on the number of resident xterm instances, log first.
uiMemoryDiagnosticsRegistry.register("xterm", () => ({ sessions: sessions.size }));

// Hide the temporary container: store the detached hostEl to prevent the xterm DOM from being destroyed when React uninstalls the rendering container.
let stashDiv: HTMLDivElement | null = null;

function getStashDiv(): HTMLDivElement | null {
  // Compatibility: SSR/web test environment may not have document.
  if (typeof document === "undefined") return null;
  if (!stashDiv) {
    stashDiv = document.createElement("div");
    stashDiv.style.display = "none";
    stashDiv.setAttribute("data-side-pane-terminal-stash", "");
    document.body.appendChild(stashDiv);
  }
  return stashDiv;
}

function releaseEntry(key: string): void {
  const entry = sessions.get(key);
  if (!entry) return;
  sessions.delete(key);
  try {
    entry.dispose();
  } catch (error) {
    // Bug description: dispose internally kills PTY/pin xterm. In theory, it should not be thrown; but even if it is thrown, it cannot block the tab closing process.
    // Otherwise, a single terminal release exception will block the entire batch shutdown (close other/all). Swallowing logs, symmetrical underside fault tolerance.
    // Risk: PTY may remain and will be recovered by terminalService disposeAll when the host exits.
    if (typeof console !== "undefined") {
      // eslint-disable-next-line no-console
      console.warn("[sidePaneTerminalSessionRegistry] release dispose failed", error);
    }
  }
  entry.hostEl.remove();
}

/**
 * The module-level singleton for side pane terminal sessions.
 *
 * It never news up XTerm or calls terminalService directly — the resources are created by the
 * TerminalSession persistentKey path, which then registers them here. The registry is only
 * responsible for "store/retrieve + DOM moves + teardown", staying decoupled from the service
 * layer.
 */
export const sidePaneTerminalSessionRegistry = {
  has(key: string): boolean {
    return sessions.has(key);
  },

  get(key: string): SidePaneTerminalSessionEntry | undefined {
    return sessions.get(key);
  },

  /**
   * After the TerminalSession persistentKey path creates the resources for the first time, store
   * the entry in the registry so it lives on.
   */
  register(key: string, entry: SidePaneTerminalSessionEntry): void {
    sessions.set(key, entry);
  },

  /**
   * Physically moves entry.hostEl into the host container (attach). The .xterm DOM subtree moves
   * along with hostEl and the term instance is unchanged; after the move the caller is responsible
   * for fitAddon.fit() to restore the size.
   */
  attachDom(key: string, host: HTMLElement): void {
    const entry = sessions.get(key);
    if (!entry) return;
    if (entry.hostEl.parentElement === host) return;
    host.appendChild(entry.hostEl);
  },

  /**
   * Moves entry.hostEl back to stashDiv (detach). Called when the component unmounts — it does not
   * dispose the term/PTY/subscriptions; the resources stay in the registry for reuse on the next
   * remount.
   */
  detachDom(key: string): void {
    const entry = sessions.get(key);
    if (!entry) return;
    const stash = getStashDiv();
    if (!stash) return;
    if (entry.hostEl.parentElement === stash) return;
    stash.appendChild(entry.hostEl);
  },

  /**
   * Called when a side pane terminal tab is explicitly closed: the real dispose (kill the PTY +
   * destroy xterm + release subscriptions).
   */
  release(key: string): void {
    releaseEntry(key);
  },

  /**
   * Bulk teardown (filtered by workspaceKey when a workspace tab closes). The mirror of the
   * openWorkspaceKeys teardown logic in Terminal.tsx on the other side.
   */
  releaseByPredicate(pred: (entry: SidePaneTerminalSessionEntry) => boolean): void {
    for (const [key, entry] of sessions) {
      if (pred(entry)) {
        releaseEntry(key);
      }
    }
  },

  /** Test-only: clears all sessions and removes stashDiv. */
  clearForTest(): void {
    for (const key of Array.from(sessions.keys())) {
      releaseEntry(key);
    }
    sessions.clear();
    if (stashDiv && typeof document !== "undefined") {
      stashDiv.remove();
      stashDiv = null;
    }
  },
};
