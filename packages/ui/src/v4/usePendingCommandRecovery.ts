import { useEffect, useState } from "react";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import { pendingCommandRegistry, type PendingCommandEntry } from "@/v4/pendingCommandRegistry.js";
import { isPendingCommandForWorkspace } from "@/v4/pendingCommandWorkspace.js";
import type { SessionDataLayer } from "@/v4/sessionDataLayer.js";

interface UsePendingCommandRecoveryOptions {
  layer: SessionDataLayer;
  sessionId: string | null;
  snapshot: ConversationSnapshot | null;
  status: "connecting" | "live" | "error" | "closed";
  subscriptionId: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * The React seam of the pending registry: the projection converges on the queue/guided/transcript
 * anchor; the remote query only runs when the subscription generation goes live, and does not
 * re-run at high frequency with streaming snapshots.
 */
export function usePendingCommandRecovery({
  layer,
  sessionId,
  snapshot,
  status,
  subscriptionId,
  workspacePath,
  workspaceIdentity,
}: UsePendingCommandRecoveryOptions): readonly PendingCommandEntry[] {
  const [version, setVersion] = useState(0);

  useEffect(() => pendingCommandRegistry.subscribe(() => setVersion((current) => current + 1)), []);

  useEffect(() => {
    if (snapshot) pendingCommandRegistry.reconcileSnapshot(snapshot);
  }, [snapshot]);

  useEffect(() => {
    if (status !== "live" || subscriptionId === null) return;
    // The current session and createSession(null bucket) can be queried in parallel; each has a single-flight inside the registry.
    const targets: Array<string | null> = sessionId === null ? [null] : [sessionId, null];
    void Promise.all(
      targets.map((target) =>
        pendingCommandRegistry.reconcileSession(target, (params) => layer.queryCommands(params)),
      ),
    ).catch((error) => {
      logger.warn(
        "[v4-pending-command] reconnect reconciliation failed, keeping the ledger for the next connection",
        error,
      );
    });
  }, [layer, sessionId, status, subscriptionId]);

  // version is a narrow subscription signal for the registry; the entire ledger is not copied into React state.
  void version;
  const scoped = pendingCommandRegistry.listRecoverable(sessionId);
  const recoverableCreates = pendingCommandRegistry
    .listRecoverable(null)
    .filter((entry) => isPendingCommandForWorkspace(entry, workspacePath, workspaceIdentity));
  // A null bucket only means that createSession has not been bound to a session, but it does not mean that it does not have a workspace.
  // Each pane subscribes to the same registry and therefore must be isolated by workspace identity before presentation/consumption.
  return sessionId === null ? recoverableCreates : [...scoped, ...recoverableCreates];
}
