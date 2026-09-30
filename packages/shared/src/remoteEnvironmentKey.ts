import type { RemoteTarget } from "./remoteTarget.js";
import { buildSshRemoteHostKey } from "./remoteSshHostKey.js";

/**
 * Stable identity for Environment-level state such as Provider Provisioning; must not mix in workspace/session identity.
 */
export function buildRemoteEnvironmentKey(target: RemoteTarget): string {
  switch (target.kind) {
    case "ssh":
      return `ssh:${buildSshRemoteHostKey(target)}`;
    case "wsl":
      return `wsl:${target.distro?.trim() || "<default>"}\0${target.user?.trim() || "<default>"}`;
  }
}
