import type { RemoteTarget } from "./remoteTarget.js";
import { buildSshRemoteHostKey } from "./remoteSshHostKey.js";

/**
 * Stable identity for Environment-level state such as Provider Provisioning; must not mix in workspace/session identity.
 */
export function buildRemoteEnvironmentKey(target: RemoteTarget): string {
  return `ssh:${buildSshRemoteHostKey(target)}`;
}
