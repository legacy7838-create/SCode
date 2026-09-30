// Unified parsing tool for remote workspace identity (Workspace Identity Constraints: Construction and Parsing
// Unified tools must be reused, and handwritten splicing/disassembly rules for business code are prohibited).
// Construct side (dual): packages/ui/src/lib/remoteWorkspaceHistory.ts
// buildRemoteWorkspaceIdentity - format contract:
//   remote:ssh:<host>:<port>:<username>:<posixPath>
//   remote:wsl:<distro>[:<user>]:<posixPath>
// The path segments are normalized by normalizeWorkspacePathForIdentity (separator → "/", remove the trailing slash,
// Empty → "/"), so it always starts with "/"; each authority section does not contain "/" (host is lowercase, port is a number,
// The legal character set of wsl distribution name does not include ":" and "/").
// Consumer: workspaceId of CLI v4 createSession (workspaceKey = in remote pane
// identity) needs to restore the real workspacePath as the session workingDirectory.
import type { RemoteTarget } from "./remoteTarget.js";

export type RemoteWorkspaceIdentityKind = "ssh" | "wsl";

export interface ParsedRemoteWorkspaceIdentity {
  kind: RemoteWorkspaceIdentityKind;
  /** Real path on the remote machine (posix-normalized form). */
  workspacePath: string;
}

const REMOTE_IDENTITY_PREFIX = "remote:";

/** Number of required authority segments (excluding kind): ssh = host/port/username, other remote kinds = a single segment. */
const AUTHORITY_SEGMENTS: Record<RemoteWorkspaceIdentityKind, number> = {
  ssh: 3,
  wsl: 1,
};

function isRemoteWorkspaceIdentityKind(value: string): value is RemoteWorkspaceIdentityKind {
  return value === "ssh" || value === "wsl";
}

function normalizeWorkspacePathForIdentity(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, "/").replace(/\/+/g, "/");
  const trimmed = normalized.replace(/^\/+|\/+$/g, "");
  return `/${trimmed}`;
}

/**
 * Single place that builds a remote workspace identity. Host, Main and UI are forbidden from assembling the
 * authority themselves; `workspacePath` is normalized here and only here before it enters the identity key,
 * while actual IO still uses the caller's original path.
 */
export function buildRemoteWorkspaceIdentity(workspacePath: string, target: RemoteTarget): string {
  const normalizedPath = normalizeWorkspacePathForIdentity(workspacePath);
  switch (target.kind) {
    case "ssh":
      return `remote:ssh:${target.host.trim().toLowerCase()}:${target.port ?? 22}:${target.username.trim()}:${normalizedPath}`;
    case "wsl": {
      const distro = target.distro?.trim() || "default";
      const user = target.user?.trim();
      return user
        ? `remote:wsl:${distro}:${user}:${normalizedPath}`
        : `remote:wsl:${distro}:${normalizedPath}`;
    }
  }
}

/**
 * Parses a remote workspace identity; an invalid or non-remote identity returns null (the caller then falls
 * back to "treat it as a local workspacePath"). Only workspacePath is extracted — authority details
 * (host/port, etc.) are meaningless to the consumer (the CLI runs on the remote machine) and are not exposed.
 */
export function parseRemoteWorkspaceIdentity(
  identity: string,
): ParsedRemoteWorkspaceIdentity | null {
  if (!identity.startsWith(REMOTE_IDENTITY_PREFIX)) {
    return null;
  }
  const rest = identity.slice(REMOTE_IDENTITY_PREFIX.length);
  const kindEnd = rest.indexOf(":");
  if (kindEnd <= 0) {
    return null;
  }
  const kind = rest.slice(0, kindEnd);
  if (!isRemoteWorkspaceIdentityKind(kind)) {
    return null;
  }
  // Consume authority segment by segment; the path segment may contain ":" (theoretically posix paths allow it),
  // Therefore, it cannot be split as a whole - after advancing by segment, the remaining entire segment is taken as path.
  let cursor = kindEnd + 1;
  for (let i = 0; i < AUTHORITY_SEGMENTS[kind]; i++) {
    const next = rest.indexOf(":", cursor);
    if (next <= cursor) {
      return null;
    }
    cursor = next + 1;
  }
  // WSL identity adds optional user section to distinguish default users from explicit users, old parser
  // Still only consumes distro, causing user to be misjudged as a path and causing identity to fail to resolve as a whole. remote path
  // Must start with "/" so that legacy userless format can be distinguished unambiguously from explicit user format.
  if (kind === "wsl" && rest[cursor] !== "/") {
    const userEnd = rest.indexOf(":", cursor);
    if (userEnd <= cursor) {
      return null;
    }
    cursor = userEnd + 1;
  }
  const workspacePath = rest.slice(cursor);
  if (!workspacePath.startsWith("/")) {
    return null;
  }
  return { kind, workspacePath };
}

/** Whether the identity is a remote workspace identity (parseable by parseRemoteWorkspaceIdentity). */
export function isRemoteWorkspaceIdentity(identity: string): boolean {
  return parseRemoteWorkspaceIdentity(identity) !== null;
}
