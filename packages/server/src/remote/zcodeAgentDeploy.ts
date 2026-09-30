import {
  ZCODE_AGENT_RUNTIME,
  ZCODE_AGENT_PROVIDER,
  type RemoteResourcePackageId,
} from "@zcode/shared";
import type { IRemoteBackend, RemoteEnvironment } from "@zcode/server/remote/backend.js";
import {
  REMOTE_BASE,
  type DeployLoggers,
  type RemoteAssetDeployOptions,
  waitForClose,
} from "@zcode/server/remote/deployShared.js";
import type { RemoteAssetInstaller } from "@zcode/server/remote/remoteAssetInstaller.js";
import { buildWriteLiteralFileCommand } from "@zcode/server/remote/posixShell.js";
import { deployDevelopmentZCodeAgentRuntime } from "@zcode/server/remote/zcodeAgentDevDeploy.js";
import {
  buildRemoteAgentBundleWrapper,
  isRemoteAgentBundleWrapperCurrent,
  REMOTE_AGENT_BUNDLE_NAME,
} from "@zcode/server/remote/zcodeAgentBundleWrapper.js";
import {
  deployRemoteAgentWrapper,
  isWslBackend,
} from "@zcode/server/remote/zcodeAgentWrapperDeploy.js";
import {
  buildRemoteAgentOfficialPluginDir,
  buildRemoteAgentOfficialPluginRequiredPaths,
  buildRemoteAgentOfficialPluginSourceRelativePath,
  REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS,
} from "@zcode/server/remote/zcodeAgentOfficialPluginAssets.js";
import { repairLegacyRemoteOfficialPluginDirectoryPermissions } from "@zcode/server/remote/zcodeAgentOfficialPluginPermissionRepair.js";
import {
  checkRemoteAssetComponentIdentity,
  writeRemoteAssetComponentMeta,
} from "@zcode/server/remote/remoteAssetLiveIdentity.js";

const REMOTE_AGENT_RUNTIME_BASE = `${REMOTE_BASE}/agents`;

export interface DeployZCodeAgentRuntimeOptions extends RemoteAssetDeployOptions {
  platformArch: string;
  installer: RemoteAssetInstaller;
  selectedResourcePackageIds?: RemoteResourcePackageId[];
  force?: boolean;
}

function isSelectedZCodeAgentComponent(
  componentId: string,
  selectedResourcePackageIds: readonly RemoteResourcePackageId[] | undefined,
): boolean {
  return (
    !selectedResourcePackageIds ||
    selectedResourcePackageIds.includes(componentId as RemoteResourcePackageId)
  );
}

async function shouldSkipZCodeAgentDeploy(params: {
  backend: IRemoteBackend;
  remoteBinaryPath: string;
  remoteBundlePath: string;
  runtimeResourceDir: string;
  expectedArtifactSha256: string | null;
  componentId: string;
  platformArch: string;
  force: boolean;
  missingOfficialPluginAssetPaths: string[];
  installer: RemoteAssetInstaller;
  loggers: DeployLoggers;
}): Promise<boolean> {
  if (params.force) {
    return false;
  }

  if (!params.expectedArtifactSha256) {
    params.loggers.logWarn(
      `[remote-assets] ${params.installer.mode === "remote-download" ? "download required" : "upload required"}: component=${params.componentId} reason=manifest SHA unavailable`,
    );
    return false;
  }

  const identityDecision = await checkRemoteAssetComponentIdentity(params.backend, {
    componentId: params.componentId,
    platformArch: params.platformArch,
    expectedIdentity: { sha256: params.expectedArtifactSha256 },
  });
  if (identityDecision.shouldDeploy) {
    params.loggers.logWarn(
      `[remote-assets] ${params.installer.mode === "remote-download" ? "download required" : "upload required"}: component=${params.componentId} reason=${identityDecision.reason}`,
    );
    return false;
  }

  if (!(await params.backend.exists(params.remoteBinaryPath))) {
    params.loggers.logWarn(
      `[remote-assets] ${params.installer.mode === "remote-download" ? "download required" : "upload required"}: component=${params.componentId} reason=remote wrapper missing path=${params.remoteBinaryPath}`,
    );
    return false;
  }

  if (isWslBackend(params.backend)) {
    try {
      const remoteWrapper = await params.backend.readFile(params.remoteBinaryPath);
      if (!isRemoteAgentBundleWrapperCurrent(remoteWrapper, params.runtimeResourceDir)) {
        params.loggers.logWarn(
          `[remote-assets] ${params.installer.mode === "remote-download" ? "download required" : "upload required"}: component=${params.componentId} reason=wsl wrapper stale path=${params.remoteBinaryPath}`,
        );
        return false;
      }
    } catch {
      return false;
    }
  }

  // The wrapper also needs to be redeployed when zcode.cjs is missing (cleaned/remaining from the old native binary deployment).
  if (!(await params.backend.exists(params.remoteBundlePath))) {
    params.loggers.logWarn(
      `[remote-assets] ${params.installer.mode === "remote-download" ? "download required" : "upload required"}: component=${params.componentId} reason=remote bundle missing path=${params.remoteBundlePath}`,
    );
    return false;
  }

  if (params.missingOfficialPluginAssetPaths.length > 0) {
    params.loggers.logWarn(
      `[remote-assets] ${params.installer.mode === "remote-download" ? "download required" : "upload required"}: component=${params.componentId} reason=official plugin assets missing paths=${params.missingOfficialPluginAssetPaths.join(",")}`,
    );
    return false;
  }

  params.loggers.log(
    `[zcode-agent-deploy] ${ZCODE_AGENT_PROVIDER}: artifact SHA ${params.expectedArtifactSha256} is already deployed, skipping`,
  );
  return true;
}

async function findMissingRemoteOfficialPluginAssetPaths(
  backend: IRemoteBackend,
  remoteProviderDir: string,
): Promise<string[]> {
  const missingPaths: string[] = [];
  for (const remotePath of buildRemoteAgentOfficialPluginRequiredPaths(remoteProviderDir)) {
    if (!(await backend.exists(remotePath))) {
      missingPaths.push(remotePath);
    }
  }
  return missingPaths;
}

/**
 * Deploys the ZCode Agent runtime to a remote machine.
 *
 * In production only the manifest SHA decides whether the artifact changed; the semantic version
 * takes no part in the skip decision.
 */
export async function deployZCodeAgentRuntime(
  backend: IRemoteBackend,
  env: RemoteEnvironment,
  options: DeployZCodeAgentRuntimeOptions,
  loggers: DeployLoggers,
): Promise<void> {
  const provider = ZCODE_AGENT_PROVIDER;
  const runtime = ZCODE_AGENT_RUNTIME;
  const componentId = provider;
  if (!isSelectedZCodeAgentComponent(componentId, options.selectedResourcePackageIds)) {
    loggers.log(
      `[zcode-agent-deploy] ${provider}: resource package ${componentId} is not selected, skipping the check and deploy`,
    );
    return;
  }

  // binaryName refers to the name of the wrapper executable file (such as zcode-agent / zcode-agent.exe)——
  // A shell script that calls the remote node to execute zcode.cjs.
  const binaryName = runtime.resolveEntrySegments(env.platform).at(-1);
  if (!binaryName) {
    loggers.logWarn(
      `[zcode-agent-deploy] ${provider}: could not resolve the agent entry name, skipping the deploy`,
    );
    return;
  }

  const remoteProviderDir = `${REMOTE_AGENT_RUNTIME_BASE}/${runtime.bundledResourceDir}`;
  const remoteVersionFile = `${remoteProviderDir}/.version`;
  const remoteBinaryPath = `${remoteProviderDir}/${binaryName}`;
  const remoteBundlePath = `${remoteProviderDir}/${REMOTE_AGENT_BUNDLE_NAME}`;
  const remoteOfficialPluginDir = buildRemoteAgentOfficialPluginDir(remoteProviderDir);
  const missingOfficialPluginAssetPaths = await findMissingRemoteOfficialPluginAssetPaths(
    backend,
    remoteProviderDir,
  );

  if (
    await deployDevelopmentZCodeAgentRuntime(
      backend,
      {
        runtimeVersion: runtime.version,
        runtimeResourceDir: runtime.bundledResourceDir,
        remoteProviderDir,
        remoteVersionFile,
        remoteBinaryPath,
        force: Boolean(options.force),
      },
      loggers,
    )
  ) {
    return;
  }

  let expectedArtifactSha256: string | null = null;
  try {
    expectedArtifactSha256 =
      (await options.installer.resolveComponentSha256?.(componentId)) ?? null;
  } catch (error) {
    loggers.logWarn(
      `[zcode-agent-deploy] ${provider}: failed to read the manifest SHA, redeploying: ${String(error)}`,
    );
  }

  if (
    await shouldSkipZCodeAgentDeploy({
      backend,
      remoteBinaryPath,
      remoteBundlePath,
      runtimeResourceDir: runtime.bundledResourceDir,
      expectedArtifactSha256,
      componentId,
      platformArch: options.platformArch,
      force: Boolean(options.force),
      missingOfficialPluginAssetPaths,
      installer: options.installer,
      loggers,
    })
  ) {
    return;
  }

  loggers.log(`[zcode-agent-deploy] ${provider}: starting to deploy v${runtime.version}...`);
  // The lack of remote plugin only means that the installation is incomplete and does not mean that the App version has changed.
  // When repairing the plugin with the same App version, the verified component cache should be reused; only if the deployment boundary is enforced, the product should be re-downloaded.
  const forceRefreshRuntimeAsset = Boolean(options.force);
  const permissionRepairSucceeded = await repairLegacyRemoteOfficialPluginDirectoryPermissions({
    backend,
    loggers,
    remoteOfficialPluginDir,
  });
  const installBundle = () =>
    options.installer.installFile({
      componentId,
      sourceRelativePath: `${runtime.bundledResourceDir}/${options.platformArch}/${REMOTE_AGENT_BUNDLE_NAME}`,
      remotePath: remoteBundlePath,
      executable: false,
      forceRefresh: forceRefreshRuntimeAsset,
    });
  const installOfficialPluginPackages = () =>
    options.installer.installDirectory({
      componentId,
      sourceRelativePath: buildRemoteAgentOfficialPluginSourceRelativePath({
        runtimeResourceDir: runtime.bundledResourceDir,
        platformArch: options.platformArch,
      }),
      remoteDir: remoteOfficialPluginDir,
      requiredRelativePaths: [...REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS],
      forceRefresh: forceRefreshRuntimeAsset,
    });

  if (permissionRepairSucceeded) {
    // 1) The normal path maintains the original deployment order to avoid changing the timing semantics of healthy SSH/WSL.
    await installBundle();
    // 2) Install the official plug-in source resources released with the agent bundle for remote agent bootstrap seed builtin plugin.
    await installOfficialPluginPackages();
  } else {
    // 1) When chmod fails, first verify that packages are replaceable to avoid failure to delete old packages even though the bundle has been updated.
    await installOfficialPluginPackages();
    // 2) After the packages are successfully replaced, install the compiled product zcode.cjs (the same copy across platforms, it is included in the glm component).
    await installBundle();
  }
  // 3) Write the wrapper (i.e. the zcode-agent expected by the resolver) and execute zcode.cjs with the remote deployed node.
  await deployRemoteAgentWrapper({
    backend,
    content: buildRemoteAgentBundleWrapper(runtime.bundledResourceDir),
    remoteWrapperPath: remoteBinaryPath,
  });

  const versionStream = await backend.exec(
    buildWriteLiteralFileCommand(remoteVersionFile, runtime.version),
  );
  await waitForClose(versionStream);
  if (expectedArtifactSha256) {
    // The semantic version of GLM may not change but the artifact content has been updated. The manifest SHA must be
    // Write the remote live marker, and the next connection can determine whether to redeploy based on the real product identity.
    await writeRemoteAssetComponentMeta(backend, {
      id: componentId,
      version: runtime.version,
      sha256: expectedArtifactSha256,
      platformArch: options.platformArch,
    });
  }
  loggers.log(`[zcode-agent-deploy] ${provider}: deploy completed v${runtime.version}`);
}
