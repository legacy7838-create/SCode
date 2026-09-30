import type { RemoteWorkspaceSessionEntry } from "@zcode/shared";

interface ReconnectingRemoteWorkspaceEntry {
  workspaceKey?: string;
  id?: string;
  requestId?: string;
  target: RemoteWorkspaceSessionEntry["target"];
}

function sanitizeRemoteWorkspaceReconnectLogLabelSegment(value: string): string {
  return value.replace(/[^\w.-]+/g, "-");
}

function getRemoteWorkspaceReconnectLogTargetSuffix(
  target: RemoteWorkspaceSessionEntry["target"],
): string {
  switch (target.kind) {
    case "ssh":
      return target.host;
    case "wsl": {
      const user = target.user?.trim();
      const distro = target.distro ?? "default";
      return user ? `${distro}-${user}` : distro;
    }
  }
}

function buildRemoteWorkspaceReconnectLogLabelPrefix(
  target: RemoteWorkspaceSessionEntry["target"],
): string {
  return `remote-workspace-${target.kind}-${sanitizeRemoteWorkspaceReconnectLogLabelSegment(getRemoteWorkspaceReconnectLogTargetSuffix(target))}-`;
}

export function resolveRemoteWorkspaceReconnectLogWorkspaceKeys({
  runtimeLabel,
  runtimeRequestId,
  reconnectingEntries,
}: {
  runtimeLabel: string;
  runtimeRequestId?: string;
  reconnectingEntries: ReconnectingRemoteWorkspaceEntry[];
}): string[] {
  const normalizedRuntimeRequestId = runtimeRequestId?.trim();
  if (normalizedRuntimeRequestId) {
    return reconnectingEntries
      .filter((entry) => entry.requestId?.trim() === normalizedRuntimeRequestId)
      .map((entry) => entry.workspaceKey ?? entry.id ?? "")
      .filter((workspaceKey) => workspaceKey.length > 0);
  }

  if (!runtimeLabel.startsWith("remote-workspace-")) {
    return [];
  }

  const matchedEntries = reconnectingEntries.filter((entry) =>
    runtimeLabel.startsWith(buildRemoteWorkspaceReconnectLogLabelPrefix(entry.target)),
  );
  // The old version log does not have requestId, and can only rely on the target label prefix to find out.
  // When the same target is reconnected concurrently, the prefix will be the same, and continuing to copy to all workspaces will string diagnostic information to the error tooltip.
  // Therefore, only when there is a unique hit, it will be attributed by prefix. If there are multiple hits, the guessing will be given up and wait for the precise routing of the log with requestId.
  if (matchedEntries.length !== 1) {
    return [];
  }

  return matchedEntries
    .map((entry) => entry.workspaceKey ?? entry.id ?? "")
    .filter((workspaceKey) => workspaceKey.length > 0);
}
