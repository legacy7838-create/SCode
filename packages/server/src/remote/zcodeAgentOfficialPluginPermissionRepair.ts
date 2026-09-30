import { ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import type { IRemoteBackend } from "@zcode/server/remote/backend.js";
import { type DeployLoggers, waitForClose } from "@zcode/server/remote/deployShared.js";
import { quotePosixPathArg } from "@zcode/server/remote/posixShell.js";

export async function repairLegacyRemoteOfficialPluginDirectoryPermissions(params: {
  backend: IRemoteBackend;
  loggers: DeployLoggers;
  remoteOfficialPluginDir: string;
}): Promise<boolean> {
  // Old versions, when repackaging packages tar from Windows, would write directory mode as 0666; after remote umask is applied,
  // it becomes non-traversable 0644. When upgrading from 3.3.3 to 3.3.4, files may be complete but version changes still require replacing packages,
  // Therefore, permission repair must be bound to the deployment path of the "packages to be replaced", not the incremental skip path of the healthy remote end.
  // IRemoteBackend.exists only promises to check remote files; the SSH implementation uses test -f,
  // so directory existence and chmod must be converged in the same remote shell command.
  params.loggers.logWarn(
    `[zcode-agent-deploy] ${ZCODE_AGENT_PROVIDER}: checking and repairing the legacy builtin plugin directory permissions ${params.remoteOfficialPluginDir}`,
  );
  const quotedRemoteOfficialPluginDir = quotePosixPathArg(params.remoteOfficialPluginDir);
  const stream = await params.backend.exec(
    `if [ -d ${quotedRemoteOfficialPluginDir} ]; then command chmod -R u+rwX ${quotedRemoteOfficialPluginDir}; fi`,
  );
  try {
    await waitForClose(stream);
    return true;
  } catch (error) {
    // chmod is only a pre-repair for old WSL bad-permission directories; the real deployment success should be determined by subsequent packages replacement.
    // Some SSH mounted volumes or ACL environments may refuse chmod, but the rm/tar replacement path can still succeed.
    params.loggers.logWarn(
      `[zcode-agent-deploy] ${ZCODE_AGENT_PROVIDER}: failed to repair the legacy builtin plugin directory permissions, will still try to replace packages: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}
