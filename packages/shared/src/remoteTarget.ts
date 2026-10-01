import type { RemoteAssetInstallMode } from "./remoteAssetInstallMode.js";
import type { RemoteResourcePackageSelection } from "./remoteResourcePackages.js";

export interface SSHConnectOptions {
  kind: "ssh";
  host: string;
  port?: number;
  username: string;
  sshConfigAlias?: string;
  password?: string;
  privateKeyPath?: string;
  privateKeyPassphrase?: string;
  assetInstallMode?: RemoteAssetInstallMode;
  resourcePackages?: RemoteResourcePackageSelection;
}

/**
 * Every remote workspace connection kind.
 *
 * Was `SSHConnectOptions | WSLConnectOptions`; the WSL variant was removed
 * (`docs/specs/remove-wsl.md`). Kept as a named alias rather than inlined so
 * the ~130 files that reference it keep compiling unchanged — dropping a union
 * member is a one-file edit here and a rewrite everywhere else.
 */
export type RemoteTarget = SSHConnectOptions;

/** Removes secrets that should only exist during the current connection flow, for long-lived in-memory state and cross-process responses. */
export function stripRemoteTargetSecrets(target: RemoteTarget): RemoteTarget {
  // The non-SSH branch this used to have is gone with the union member, so the
  // destructuring is unconditional now. It stays load-bearing: `password` and
  // `privateKeyPassphrase` must still be dropped.
  const {
    password: _password,
    privateKeyPassphrase: _privateKeyPassphrase,
    ...sanitized
  } = target;
  return sanitized;
}
