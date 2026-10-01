// Unified parsing tool for remote workspace identity (Workspace Identity Constraints: Construction and Parsing
// Unified tools must be reused, and handwritten splicing/disassembly rules for business code are prohibited).
// Construct side (dual): packages/ui/src/lib/remoteWorkspaceHistory.ts
// buildRemoteWorkspaceIdentity - format contract:
//   remote:ssh:<host>:<port>:<username>:<posixPath>
// The path segments are normalized by normalizeWorkspacePathForIdentity (separator → "/", remove the trailing slash,
// Empty → "/"), so it always starts with "/"; each authority section does not contain "/" (host is lowercase, port is a number).
// Consumer: workspaceId of CLI v4 createSession (workspaceKey = in remote pane
// identity) needs to restore the real workspacePath as the session workingDirectory.
import type { RemoteTarget } from "./remoteTarget.js";

export type RemoteWorkspaceIdentityKind = "ssh";

export interface ParsedRemoteWorkspaceIdentity {
  kind: RemoteWorkspaceIdentityKind;
  /** Real path on the remote machine (posix-normalized form). */
  workspacePath: string;
}

const REMOTE_IDENTITY_PREFIX = "remote:";

/** Number of required authority segments (excluding kind): ssh = host/port/username. */
const AUTHORITY_SEGMENTS: Record<RemoteWorkspaceIdentityKind, number> = {
  ssh: 3,
};

function isRemoteWorkspaceIdentityKind(value: string): value is RemoteWorkspaceIdentityKind {
  return value === "ssh";
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
  return `remote:ssh:${target.host.trim().toLowerCase()}:${target.port ?? 22}:${target.username.trim()}:${normalizedPath}`;
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
  // Parsing deliberately keeps no per-kind tail handling: `wsl` was the only kind
  // with an optional authority section, and it was removed (docs/specs/remove-wsl.md),
  // so every remaining kind is exactly `AUTHORITY_SEGMENTS[kind]` segments then a
  // path that starts with "/".
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
