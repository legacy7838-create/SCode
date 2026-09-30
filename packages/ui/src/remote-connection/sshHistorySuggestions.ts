import type { RemoteWorkspaceSessionEntry } from "@zcode/shared";

interface SshConnectionHistorySuggestions {
  hosts: string[];
  ports: string[];
  usernames: string[];
  privateKeyPaths: string[];
}

function dedupeSuggestions(values: readonly string[]): string[] {
  const seen = new Set<string>();

  return values.flatMap((value) => {
    const normalizedValue = value.trim();
    if (!normalizedValue || seen.has(normalizedValue)) {
      return [];
    }

    seen.add(normalizedValue);
    return [normalizedValue];
  });
}

export function buildSshConnectionHistorySuggestions(
  remoteWorkspaceSessions: readonly RemoteWorkspaceSessionEntry[],
): SshConnectionHistorySuggestions {
  const sshSnapshots = remoteWorkspaceSessions.flatMap((entry) =>
    entry.target.kind === "ssh" ? [entry.target] : [],
  );

  return {
    // SSH historical candidates must be displayed in the order of recent connections, otherwise the same host/username
    // The stacking will be repeated after multiple connections, making it difficult to find the truly recently used items when focus opens the drop-down.
    hosts: dedupeSuggestions(sshSnapshots.map((snapshot) => snapshot.host)),
    ports: dedupeSuggestions(sshSnapshots.map((snapshot) => String(snapshot.port ?? 22))),
    usernames: dedupeSuggestions(sshSnapshots.map((snapshot) => snapshot.username)),
    privateKeyPaths: dedupeSuggestions(
      sshSnapshots.map((snapshot) => snapshot.privateKeyPath ?? ""),
    ),
  };
}
