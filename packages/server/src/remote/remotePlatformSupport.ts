import type { RemoteEnvironment } from "@zcode/server/remote/backend.js";

export function assertSupportedRemoteEnvironment(env: RemoteEnvironment): void {
  if (env.platform !== "win32") {
    return;
  }

  // The Windows rejection logic is hard-coded before deploy/connect, and skipDeploy bypass or inconsistent error messages are prone to occur later.
  // Currently, the remote backend and startup commands still rely on the POSIX shell; focus on the capability boundaries first, and then unify them after the Windows shell strategy is connected.
  throw new Error(
    "remote mode currently only supports POSIX shell environments; native Windows remote hosts are not supported yet",
  );
}
