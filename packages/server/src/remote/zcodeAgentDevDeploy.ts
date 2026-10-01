/* eslint-disable max-lines -- dev-mode agent deploy covers local packaging, remote owner staging, and wrapper installation; the upload transaction will be split out on its own later. */
import { ZCODE_AGENT_PROVIDER, resolveZCodeRuntimeEnv } from "@zcode/shared";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { IRemoteBackend } from "@zcode/server/remote/backend.js";
import {
  buildRemoteExecutableReplaceCommand,
  buildRemoteMoveCommand,
  type DeployLoggers,
  waitForClose,
} from "@zcode/server/remote/deployShared.js";
import {
  buildWriteLiteralFileCommand,
  quotePosixPathArg,
} from "@zcode/server/remote/posixShell.js";
import { createTarGzArchive } from "@zcode/server/remote/localTarGz.js";
import {
  buildRemoteAgentBundleWrapper,
  REMOTE_AGENT_BUNDLE_NAME,
} from "@zcode/server/remote/zcodeAgentBundleWrapper.js";
import {
  REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME,
  REMOTE_AGENT_OFFICIAL_PLUGIN_INCLUDED_TOP_LEVEL_PATHS,
  REMOTE_AGENT_OFFICIAL_PLUGIN_PACKAGE_NAMES,
  REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS,
  buildRemoteAgentOfficialPluginDir,
  buildRemoteAgentOfficialPluginRequiredPaths,
} from "@zcode/server/remote/zcodeAgentOfficialPluginAssets.js";
import { repairLegacyRemoteOfficialPluginDirectoryPermissions } from "@zcode/server/remote/zcodeAgentOfficialPluginPermissionRepair.js";

const DEV_AGENT_BUNDLE_RELATIVE_PATH = "apps/zcode-cli/packages/cli/dist/zcode.cjs";
const DEV_AGENT_BUNDLE_ENV = "ZCODE_REMOTE_DEV_AGENT_BUNDLE";
const REMOTE_DEV_AGENT_BUNDLE_NAME = REMOTE_AGENT_BUNDLE_NAME;
const REMOTE_DEV_AGENT_VERSION_FILE_NAME = ".dev-version";

interface DeployDevelopmentZCodeAgentRuntimeParams {
  runtimeVersion: string;
  runtimeResourceDir: string;
  remoteProviderDir: string;
  remoteVersionFile: string;
  remoteBinaryPath: string;
  force: boolean;
}

function findUpward(relativePath: string): { rootDir: string; path: string } | null {
  let current = resolve(process.cwd());
  while (true) {
    const candidate = join(current, relativePath);
    if (existsSync(candidate)) {
      return { rootDir: current, path: candidate };
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function shouldUseDevelopmentAgentBundle(): boolean {
  if (resolveZCodeRuntimeEnv(process.env) !== "development") {
    return false;
  }

  const explicit = process.env[DEV_AGENT_BUNDLE_ENV]?.trim().toLowerCase();
  if (explicit === "0" || explicit === "false") {
    return false;
  }
  if (explicit === "1" || explicit === "true") {
    return true;
  }

  // The repository's real dist may exist in Vitest; disabled by default to avoid ordinary deployment tests mistakenly taking the dev-state branch.
  return !process.env.VITEST;
}

function resolveDevelopmentAgentBundle(): {
  repoRoot: string;
  localBundlePath: string;
} | null {
  if (!shouldUseDevelopmentAgentBundle()) {
    return null;
  }
  const found = findUpward(DEV_AGENT_BUNDLE_RELATIVE_PATH);
  return found ? { repoRoot: found.rootDir, localBundlePath: found.path } : null;
}

async function computeDevelopmentAgentAssetsSha256(params: {
  localBundlePath: string;
  repoRoot: string;
}): Promise<string> {
  const hash = createHash("sha256");
  hash.update("bundle:zcode.cjs\n");
  hash.update(await readFile(params.localBundlePath));
  for (const packageName of REMOTE_AGENT_OFFICIAL_PLUGIN_PACKAGE_NAMES) {
    const packageRoot = join(params.repoRoot, "apps", "zcode-cli", "packages", packageName);
    hash.update(`plugin:${packageName}\n`);
    await hashDevelopmentOfficialPluginPackage(hash, packageRoot, packageName);
  }
  return hash.digest("hex");
}

async function hashDevelopmentOfficialPluginPackage(
  hash: ReturnType<typeof createHash>,
  packageRoot: string,
  packageName: string,
): Promise<void> {
  const manifestPath = join(packageRoot, ".zcode-plugin", "plugin.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`[zcode-agent-deploy] missing official plugin manifest: ${manifestPath}`);
  }
  assertDevelopmentOfficialPluginRequiredAssets(packageRoot, packageName);

  for (const topLevelPath of REMOTE_AGENT_OFFICIAL_PLUGIN_INCLUDED_TOP_LEVEL_PATHS) {
    const sourcePath = join(packageRoot, topLevelPath);
    if (existsSync(sourcePath)) {
      await hashLocalPath(hash, sourcePath, `${packageName}/${topLevelPath}`);
    }
  }
}

async function hashLocalPath(
  hash: ReturnType<typeof createHash>,
  filePath: string,
  relativePath: string,
): Promise<void> {
  const fileStat = await lstat(filePath);
  if (fileStat.isDirectory()) {
    hash.update(`dir:${relativePath}\n`);
    const children = (await readdir(filePath)).sort((left, right) =>
      left.localeCompare(right, "en"),
    );
    for (const child of children) {
      await hashLocalPath(hash, join(filePath, child), `${relativePath}/${child}`);
    }
    return;
  }

  if (fileStat.isSymbolicLink()) {
    hash.update(`symlink:${relativePath}:${await readlink(filePath)}\n`);
    return;
  }

  if (!fileStat.isFile()) {
    return;
  }

  hash.update(`file:${relativePath}:${fileStat.mode & 0o777}:${fileStat.size}\n`);
  hash.update(await readFile(filePath));
}

function assertDevelopmentOfficialPluginRequiredAssets(
  packageRoot: string,
  packageName: string,
): void {
  const packagePrefix = `${packageName}/`;
  for (const requiredRelativePath of REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS) {
    if (!requiredRelativePath.startsWith(packagePrefix)) continue;
    const localRelativePath = requiredRelativePath.slice(packagePrefix.length);
    const requiredPath = join(packageRoot, ...localRelativePath.split("/"));
    if (!existsSync(requiredPath)) {
      throw new Error(
        `[zcode-agent-deploy] missing official plugin required asset: ${requiredPath}`,
      );
    }
  }
}

async function findMissingRemoteOfficialPluginAssetPaths(params: {
  backend: IRemoteBackend;
  remoteProviderDir: string;
}): Promise<string[]> {
  const missingPaths: string[] = [];
  for (const remotePath of buildRemoteAgentOfficialPluginRequiredPaths(params.remoteProviderDir)) {
    if (!(await params.backend.exists(remotePath))) {
      missingPaths.push(remotePath);
    }
  }
  return missingPaths;
}

async function shouldSkipDevelopmentZCodeAgentDeploy(params: {
  backend: IRemoteBackend;
  remoteVersionFile: string;
  remoteDevVersionFile: string;
  remoteBinaryPath: string;
  remoteBundlePath: string;
  runtimeResourceDir: string;
  runtimeVersion: string;
  devVersion: string;
  force: boolean;
  missingOfficialPluginAssetPaths: string[];
  loggers: DeployLoggers;
}): Promise<boolean> {
  if (params.force) {
    return false;
  }

  let remoteVersion: string;
  let remoteDevVersion: string;
  try {
    remoteVersion = (await params.backend.readFile(params.remoteVersionFile)).trim();
    remoteDevVersion = (await params.backend.readFile(params.remoteDevVersionFile)).trim();
  } catch {
    return false;
  }

  if (remoteVersion !== params.runtimeVersion || remoteDevVersion !== params.devVersion) {
    return false;
  }

  if (!(await params.backend.exists(params.remoteBinaryPath))) {
    return false;
  }


  if (!(await params.backend.exists(params.remoteBundlePath))) {
    return false;
  }

  if (params.missingOfficialPluginAssetPaths.length > 0) {
    return false;
  }

  params.loggers.log(
    `[zcode-agent-deploy] ${ZCODE_AGENT_PROVIDER}: the development zcode.cjs is unchanged, skipping`,
  );
  return true;
}

async function stageDevelopmentOfficialPluginPackages(params: {
  repoRoot: string;
  packagesDir: string;
}): Promise<void> {
  await mkdir(params.packagesDir, { recursive: true });
  for (const packageName of REMOTE_AGENT_OFFICIAL_PLUGIN_PACKAGE_NAMES) {
    const sourceRoot = join(params.repoRoot, "apps", "zcode-cli", "packages", packageName);
    const manifestPath = join(sourceRoot, ".zcode-plugin", "plugin.json");
    if (!existsSync(manifestPath)) {
      throw new Error(`[zcode-agent-deploy] missing official plugin manifest: ${manifestPath}`);
    }
    assertDevelopmentOfficialPluginRequiredAssets(sourceRoot, packageName);

    const targetRoot = join(params.packagesDir, packageName);
    await mkdir(targetRoot, { recursive: true });
    for (const topLevelPath of REMOTE_AGENT_OFFICIAL_PLUGIN_INCLUDED_TOP_LEVEL_PATHS) {
      const sourcePath = join(sourceRoot, topLevelPath);
      if (existsSync(sourcePath)) {
        await cp(sourcePath, join(targetRoot, topLevelPath), {
          recursive: true,
        });
      }
    }
  }
}

async function uploadDevelopmentOfficialPluginPackages(params: {
  backend: IRemoteBackend;
  repoRoot: string;
  remoteProviderDir: string;
  loggers: DeployLoggers;
}): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "zcode-remote-agent-packages-"));
  const packagesDir = join(tempDir, REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME);
  const archivePath = join(tempDir, `${REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME}.tar.gz`);
  try {
    await stageDevelopmentOfficialPluginPackages({
      repoRoot: params.repoRoot,
      packagesDir,
    });
    await createTarGzArchive(archivePath, [
      {
        sourcePath: packagesDir,
        archivePath: REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME,
      },
    ]);

    const ownerSuffix = `${Date.now()}-${randomUUID()}`;
    // Dev-state official plugins previously used a fixed packages.tar.gz; multiple deployment owners would overwrite each other's uploads.
    // archive/extract uses the same owner suffix, so failure cleanup will not mistakenly delete other deployers' files.
    const remoteArchivePath = `${params.remoteProviderDir}/${REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME}.tar.gz-${ownerSuffix}`;
    const remoteExtractDir = `${params.remoteProviderDir}/${REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME}.extract-${ownerSuffix}`;
    const extractedPackagesDir = `${remoteExtractDir}/${REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME}`;
    const cleanupRemoteStaging = async (): Promise<void> => {
      try {
        const cleanupStream = await params.backend.exec(
          `rm -f ${quotePosixPathArg(remoteArchivePath)} && rm -rf ${quotePosixPathArg(remoteExtractDir)}`,
        );
        await waitForClose(cleanupStream);
      } catch (error) {
        params.loggers.logWarn(
          `[zcode-agent-deploy] ${ZCODE_AGENT_PROVIDER}: failed to clean up the owner staging (${ownerSuffix}): ${String(error)}`,
        );
      }
    };
    params.loggers.log(
      `[zcode-agent-deploy] ${ZCODE_AGENT_PROVIDER}: uploading official plugin assets for the development build`,
    );
    try {
      await params.backend.upload(archivePath, remoteArchivePath);
      await repairLegacyRemoteOfficialPluginDirectoryPermissions({
        backend: params.backend,
        loggers: params.loggers,
        remoteOfficialPluginDir: buildRemoteAgentOfficialPluginDir(params.remoteProviderDir),
      });
      const stream = await params.backend.exec(
        [
          "set -eu",
          `cleanup_staging() { rm -f ${quotePosixPathArg(remoteArchivePath)}; rm -rf ${quotePosixPathArg(remoteExtractDir)}; }`,
          "trap cleanup_staging EXIT HUP INT TERM",
          `rm -rf ${quotePosixPathArg(remoteExtractDir)}`,
          `mkdir -p ${quotePosixPathArg(remoteExtractDir)} ${quotePosixPathArg(params.remoteProviderDir)}`,
          `tar -xzf ${quotePosixPathArg(remoteArchivePath)} -C ${quotePosixPathArg(remoteExtractDir)}`,
          `test -d ${quotePosixPathArg(extractedPackagesDir)}`,
          `rm -rf ${quotePosixPathArg(`${params.remoteProviderDir}/${REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME}`)}`,
          buildRemoteMoveCommand(
            extractedPackagesDir,
            `${params.remoteProviderDir}/${REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME}`,
          ),
          "cleanup_staging",
          "trap - EXIT HUP INT TERM",
        ].join("\n"),
      );
      await waitForClose(stream);
    } catch (error) {
      await cleanupRemoteStaging();
      throw error;
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function deployDevelopmentZCodeAgentRuntime(
  backend: IRemoteBackend,
  params: DeployDevelopmentZCodeAgentRuntimeParams,
  loggers: DeployLoggers,
): Promise<boolean> {
  const developmentBundle = resolveDevelopmentAgentBundle();
  if (!developmentBundle) {
    return false;
  }

  const remoteBundlePath = `${params.remoteProviderDir}/${REMOTE_DEV_AGENT_BUNDLE_NAME}`;
  const remoteDevVersionFile = `${params.remoteProviderDir}/${REMOTE_DEV_AGENT_VERSION_FILE_NAME}`;
  const devVersion = await computeDevelopmentAgentAssetsSha256({
    localBundlePath: developmentBundle.localBundlePath,
    repoRoot: developmentBundle.repoRoot,
  });
  const missingOfficialPluginAssetPaths = await findMissingRemoteOfficialPluginAssetPaths({
    backend,
    remoteProviderDir: params.remoteProviderDir,
  });

  if (
    await shouldSkipDevelopmentZCodeAgentDeploy({
      backend,
      remoteVersionFile: params.remoteVersionFile,
      remoteDevVersionFile,
      remoteBinaryPath: params.remoteBinaryPath,
      remoteBundlePath,
      runtimeResourceDir: params.runtimeResourceDir,
      runtimeVersion: params.runtimeVersion,
      devVersion,
      force: params.force,
      missingOfficialPluginAssetPaths,
      loggers,
    })
  ) {
    return true;
  }

  // Dev-state SSH remote previously only deployed local zcode.cjs and did not carry packages/*-plugin.
  // The builtin plugin seed depends on official plugin source resources next to the agent package, so dev deployment needs to sync both bundle and plugin resources.
  // After modifying apps/zcode-cli locally, remote tests still run the stale release package. Here we change to uploading the freshly built one at dev startup,
  // dist/zcode.cjs, and wrap it with the remotely deployed node to start, ensuring the agent still runs on the target machine.
  loggers.log(
    `[zcode-agent-deploy] ${ZCODE_AGENT_PROVIDER}: uploading the local zcode.cjs for the development build ${devVersion.slice(0, 12)}`,
  );
  const mkdirStream = await backend.exec(`mkdir -p ${quotePosixPathArg(params.remoteProviderDir)}`);
  await waitForClose(mkdirStream);

  const remoteBundleTempPath = `${remoteBundlePath}.new`;
  await backend.upload(developmentBundle.localBundlePath, remoteBundleTempPath);
  const bundleStream = await backend.exec(
    buildRemoteMoveCommand(remoteBundleTempPath, remoteBundlePath),
  );
  await waitForClose(bundleStream);
  await uploadDevelopmentOfficialPluginPackages({
    backend,
    repoRoot: developmentBundle.repoRoot,
    remoteProviderDir: params.remoteProviderDir,
    loggers,
  });

  const wrapperContent = buildRemoteAgentBundleWrapper(params.runtimeResourceDir);
  const markerCommands = [
    buildWriteLiteralFileCommand(remoteDevVersionFile, devVersion),
    buildWriteLiteralFileCommand(params.remoteVersionFile, params.runtimeVersion),
  ];
  const remoteWrapperTempPath = `${params.remoteBinaryPath}.new`;
  const markerStream = await backend.exec(
    [
      buildWriteLiteralFileCommand(remoteWrapperTempPath, wrapperContent),
      buildRemoteExecutableReplaceCommand(remoteWrapperTempPath, params.remoteBinaryPath),
      ...markerCommands,
    ].join(" && "),
  );
  await waitForClose(markerStream);
  loggers.log(
    `[zcode-agent-deploy] ${ZCODE_AGENT_PROVIDER}: development deploy completed ${devVersion.slice(0, 12)}`,
  );
  return true;
}
