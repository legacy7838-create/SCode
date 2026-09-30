/* eslint-disable max-lines -- The remote asset install policy carries both local upload and remote download; it will be split once it has settled. */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, posix } from "node:path";
import type { RemoteAssetInstallMode } from "@zcode/shared";
import type { IRemoteBackend, StdioStream } from "@zcode/server/remote/backend.js";
import {
  REMOTE_BASE,
  buildRemoteExecutableReplaceCommand,
  buildRemoteMoveCommand,
  createRemoteAssetPlaceholderError,
  fileExists,
  type DeployLoggers,
  type RemoteAssetDeployOptions,
  waitForClose,
} from "@zcode/server/remote/deployShared.js";
import { quotePosixPathArg, quotePosixShellArg } from "@zcode/server/remote/posixShell.js";
import {
  buildComponentArtifactUrlCandidates,
  buildReleaseAssetUrlCandidates,
  buildReleaseBaseCandidates,
  resolveRemoteCdnBaseUrls,
} from "@zcode/server/remote/remoteAssetCdn.js";
import {
  ensureRemoteReleaseDirFromCdn,
  buildRemoteAssetManifestFileCandidates,
  createRemoteAssetManifestRequestSignal,
  parseRemoteAssetManifestFromResponse,
  resolveRemoteAssetComponentCacheVersion,
  selectRemoteAssetManifestComponents,
  usesRemoteAssetContentAddressedCacheIdentity,
  type RemoteAssetManifest,
  type RemoteAssetManifestComponent,
  type RemoteAssetManifestRef,
} from "@zcode/server/remote/remoteAssetCache.js";
import { createTarGzArchive } from "@zcode/server/remote/localTarGz.js";
import type {
  RemoteAssetTools,
  RemoteDownloadTool,
  RemoteSha256Tool,
} from "@zcode/server/remote/remoteAssetPreflight.js";
import {
  resolveRemoteAssetFetch,
  type RemoteAssetNetworkPort,
} from "@zcode/server/remote/remoteAssetNetwork.js";

export interface RemoteAssetInstaller {
  readonly mode: RemoteAssetInstallMode;
  resolveComponentVersion?(componentId: string): Promise<string | null>;
  resolveComponentSha256?(componentId: string): Promise<string | null>;
  installFile(params: {
    componentId: string;
    sourceRelativePath: string;
    remotePath: string;
    executable?: boolean;
    forceRefresh?: boolean;
  }): Promise<void>;
  installDirectory(params: {
    componentId: string;
    sourceRelativePath: string;
    remoteDir: string;
    requiredRelativePaths?: string[];
    forceRefresh?: boolean;
  }): Promise<void>;
}

function throwIfRemoteAssetInstallAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  if (signal.reason instanceof Error) {
    throw signal.reason;
  }
  const error = new Error("Remote asset installation canceled");
  error.name = "AbortError";
  throw error;
}

function buildStaleRemoteStagingCleanupCommand(parentDir: string, patterns: string[]): string {
  const quotedParentDir = quotePosixPathArg(parentDir);
  const candidateExpressions = patterns.map((pattern) => {
    const literalPrefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
    return `${quotedParentDir}/${quotePosixShellArg(literalPrefix)}*`;
  });
  return [
    `for candidate in ${candidateExpressions.join(" ")}; do`,
    'test -e "$candidate" || continue',
    // SSH cancellation will first release the old backend, and you can no longer use the old credentials to cleanup immediately.
    // New connections will only recycle ZCode owner staging that exceeds 24 hours to avoid accidentally deleting the current owner or active deployments within the normal period.
    'find "$candidate" -prune -mtime +0 -exec rm -rf {} + 2>/dev/null || true',
    "done",
  ].join("\n");
}

export function buildRemoteArtifactDownloadCommand(params: {
  tool: RemoteDownloadTool;
  urls: string[];
  outputPath: string;
  progressLabel: string;
  totalBytes?: number | null;
  expectedSha256?: string;
  sha256Tool?: RemoteSha256Tool;
}): string {
  const shouldVerifyChecksum =
    typeof params.expectedSha256 === "string" &&
    params.expectedSha256.length > 0 &&
    typeof params.sha256Tool === "string";
  const attempts = params.urls.map((url) => {
    const quotedOutputPath = quotePosixPathArg(params.outputPath);
    if (params.tool === "curl") {
      return buildRemoteArtifactDownloadAttempt({
        downloadCommand: `curl -fL --retry 2 --connect-timeout 20 -o ${quotedOutputPath} ${quotePosixPathArg(url)}`,
        outputPath: params.outputPath,
        progressLabel: params.progressLabel,
        expectedSha256: shouldVerifyChecksum ? params.expectedSha256 : undefined,
        sha256Tool: shouldVerifyChecksum ? params.sha256Tool : undefined,
      });
    }
    return buildRemoteArtifactDownloadAttempt({
      downloadCommand: `wget --tries=3 --timeout=20 -O ${quotedOutputPath} ${quotePosixPathArg(url)}`,
      outputPath: params.outputPath,
      progressLabel: params.progressLabel,
      expectedSha256: shouldVerifyChecksum ? params.expectedSha256 : undefined,
      sha256Tool: shouldVerifyChecksum ? params.sha256Tool : undefined,
    });
  });
  return buildRemoteDownloadWithProgressCommand({
    attemptCommand: attempts.map((attempt) => `(${attempt})`).join(" || "),
    outputPath: params.outputPath,
    progressLabel: params.progressLabel,
    totalBytes: params.totalBytes,
  });
}

function buildRemoteArtifactDownloadAttempt(params: {
  downloadCommand: string;
  outputPath: string;
  progressLabel: string;
  expectedSha256?: string;
  sha256Tool?: RemoteSha256Tool;
}): string {
  if (!params.expectedSha256 || !params.sha256Tool) {
    return params.downloadCommand;
  }

  const checksumCommand = buildRemoteChecksumCommand({
    tool: params.sha256Tool,
    filePath: params.outputPath,
  });
  const quotedOutputPath = quotePosixPathArg(params.outputPath);
  const quotedExpectedSha256 = quotePosixShellArg(params.expectedSha256);
  const mismatchPrefix = quotePosixShellArg(
    `[remote-assets] sha256 mismatch for ${params.progressLabel}: expected=${params.expectedSha256}, actual=`,
  );

  // When there is a brief inconsistency in multi-CDN publishing, the first URL may download but the sha points to the old object.
  // Put the verification into the try block of each candidate URL to continue trying the alternative CDN after a mismatch.
  return [
    `rm -f ${quotedOutputPath}`,
    params.downloadCommand,
    `actual_sha=$(${checksumCommand})`,
    `if [ "$actual_sha" = ${quotedExpectedSha256} ]; then true; else echo ${mismatchPrefix}"$actual_sha" >&2; false; fi`,
  ].join(" && ");
}

function buildRemoteDownloadWithProgressCommand(params: {
  attemptCommand: string;
  outputPath: string;
  progressLabel: string;
  totalBytes?: number | null;
}): string {
  const quotedOutputPath = quotePosixPathArg(params.outputPath);
  const quotedProgressLabel = quotePosixShellArg(params.progressLabel);
  const totalBytes = normalizeTotalBytes(params.totalBytes);
  const progressPrinter =
    totalBytes != null
      ? `awk -v label=${quotedProgressLabel} -v bytes="$progress_size" -v total=${totalBytes} -v elapsed="$progress_elapsed" 'BEGIN { transferred = bytes / 1048576; total_mb = total / 1048576; speed = transferred / elapsed; percent = bytes / total * 100; if (percent > 100) percent = 100; printf "download progress: [%s] %.1f%% (%.1f/%.1f MB, %.2f MB/s)\\n", label, percent, transferred, total_mb, speed; fflush(); }'`
      : `awk -v label=${quotedProgressLabel} -v bytes="$progress_size" -v elapsed="$progress_elapsed" 'BEGIN { transferred = bytes / 1048576; speed = transferred / elapsed; printf "download progress: [%s] %.1f MB (total unknown, %.2f MB/s)\\n", label, transferred, speed; fflush(); }'`;
  const updateProgressVars = `if [ -f ${quotedOutputPath} ]; then progress_size=$(wc -c < ${quotedOutputPath} 2>/dev/null || printf 0); else progress_size=0; fi; progress_now=$(date +%s); progress_elapsed=$((progress_now - progress_started_at)); if [ "$progress_elapsed" -le 0 ]; then progress_elapsed=1; fi`;
  const progressLoop = `progress_started_at=$(date +%s); progress_pid=; (last_progress_size=-1; while :; do ${updateProgressVars}; if [ "$progress_size" != "$last_progress_size" ]; then ${progressPrinter}; last_progress_size="$progress_size"; fi; sleep 1; done) & progress_pid=$!`;
  const stopProgressLoop = `if [ -n "$progress_pid" ]; then kill "$progress_pid" >/dev/null 2>&1 || true; wait "$progress_pid" 2>/dev/null || true; fi; if [ -f ${quotedOutputPath} ]; then ${updateProgressVars}; ${progressPrinter}; fi`;

  // The remote server download used to only wait for wget/curl to end, and there was no speed and progress feedback in the connection window.
  // This does not rely on the unstable progress bars of wget/curl. Instead, it throttles and outputs a unified format based on the target file size at the remote end.
  // The connection window can reuse the existing download progress merge logic to display the latest speed.
  return `set +e; ${progressLoop}; ${params.attemptCommand}; download_status=$?; set -e; ${stopProgressLoop}; test "$download_status" -eq 0`;
}

function normalizeTotalBytes(totalBytes: number | null | undefined): number | null {
  if (typeof totalBytes !== "number" || !Number.isFinite(totalBytes)) {
    return null;
  }
  const normalized = Math.floor(totalBytes);
  return normalized > 0 ? normalized : null;
}

export function buildRemoteChecksumCommand(params: {
  tool: RemoteSha256Tool;
  filePath: string;
}): string {
  const file = quotePosixPathArg(params.filePath);
  if (params.tool === "sha256sum") {
    return `sha256sum ${file} | awk '{print $1}'`;
  }
  if (params.tool === "shasum") {
    return `shasum -a 256 ${file} | awk '{print $1}'`;
  }
  return `openssl dgst -sha256 ${file} | awk '{print $NF}'`;
}

export class LocalUploadAssetInstaller implements RemoteAssetInstaller {
  readonly mode = "local-download-upload" as const;

  constructor(
    private readonly backend: IRemoteBackend,
    private readonly options: RemoteAssetDeployOptions & {
      platformArch?: string;
      version?: string;
    },
    private readonly loggers: DeployLoggers,
  ) {}

  async resolveComponentVersion(componentId: string): Promise<string | null> {
    return (await this.resolveManifestComponent(componentId))?.version ?? null;
  }

  async resolveComponentSha256(componentId: string): Promise<string | null> {
    const resolvedSha256 = await this.options.resolveComponentSha256?.(componentId);
    if (resolvedSha256) {
      return resolvedSha256;
    }
    return (await this.resolveManifestComponent(componentId))?.sha256 ?? null;
  }

  private async resolveManifestComponent(
    componentId: string,
  ): Promise<RemoteAssetManifestComponent | null> {
    const platformArch = this.options.platformArch?.trim();
    const releaseDir =
      this.options.releaseDir?.trim() ??
      (await this.options.resolveReleaseDir?.([componentId]))?.trim();
    if (!platformArch || !releaseDir) {
      return null;
    }

    try {
      const manifest = JSON.parse(
        readFileSync(join(releaseDir, `manifest-${platformArch}.json`), "utf8"),
      ) as RemoteAssetManifest;
      return selectRemoteAssetManifestComponents(manifest, [componentId])[0] ?? null;
    } catch {
      return null;
    }
  }

  async tryResolveLocalPath(
    componentIds: string[],
    sourceRelativePath: string,
    requiredReleasePaths?: string[],
    forceRefresh = false,
  ): Promise<string | null> {
    const releaseDir =
      this.options.releaseDir ??
      (await this.options.resolveReleaseDir?.(componentIds, {
        forceRefresh,
      })) ??
      null;
    if (!releaseDir) {
      return null;
    }

    const localPath = join(releaseDir, sourceRelativePath);
    if (await fileExists(localPath)) {
      const missingRequiredPaths = await findMissingLocalRequiredReleasePaths(
        releaseDir,
        requiredReleasePaths,
      );
      if (missingRequiredPaths.length === 0) {
        return localPath;
      }
      // The old cache may already have the packages parent directory, but lacks the plugin.json required for this deployment.
      // You cannot just check the existence of the parent directory here, otherwise incomplete official plug-in resources will continue to be uploaded.
      this.loggers.logWarn(
        `[remote-assets] local release asset incomplete: source=${localPath} missing=${missingRequiredPaths.join(",")}; trying CDN cache fallback`,
      );
    }

    const cdnReleaseDir = await this.tryResolveCdnReleaseDir(
      componentIds,
      requiredReleasePaths,
      forceRefresh,
    );
    if (!cdnReleaseDir) {
      return null;
    }
    const cdnLocalPath = join(cdnReleaseDir, sourceRelativePath);
    if (!(await fileExists(cdnLocalPath))) {
      return null;
    }
    const missingCdnRequiredPaths = await findMissingLocalRequiredReleasePaths(
      cdnReleaseDir,
      requiredReleasePaths,
    );
    if (missingCdnRequiredPaths.length > 0) {
      this.loggers.logWarn(
        `[remote-assets] CDN release asset incomplete: source=${cdnLocalPath} missing=${missingCdnRequiredPaths.join(",")}`,
      );
      return null;
    }
    return cdnLocalPath;
  }

  async resolveLocalPath(
    componentIds: string[],
    sourceRelativePath: string,
    requiredReleasePaths?: string[],
    forceRefresh = false,
  ): Promise<string> {
    const localPath = await this.tryResolveLocalPath(
      componentIds,
      sourceRelativePath,
      requiredReleasePaths,
      forceRefresh,
    );
    if (localPath) {
      return localPath;
    }

    const releaseDir =
      this.options.releaseDir ??
      (await this.options.resolveReleaseDir?.(componentIds, {
        forceRefresh,
      })) ??
      null;
    if (!releaseDir) {
      throw createRemoteAssetPlaceholderError(
        this.options.platformArch ?? "<unknown>",
        this.options,
        componentIds.join(","),
      );
    }
    throw new Error(
      `[deploy] local remote asset not found: ${join(releaseDir, sourceRelativePath)} (component=${componentIds.join(",")})`,
    );
  }

  async installFile(params: {
    componentId: string;
    sourceRelativePath: string;
    remotePath: string;
    executable?: boolean;
    forceRefresh?: boolean;
  }): Promise<void> {
    throwIfRemoteAssetInstallAborted(this.options.signal);
    const localPath = await this.resolveLocalPath(
      [params.componentId],
      params.sourceRelativePath,
      undefined,
      Boolean(params.forceRefresh),
    );
    // Shared local cache can be completed after cancellation, but late continuations must not be allowed to write remote staging.
    throwIfRemoteAssetInstallAborted(this.options.signal);
    // Multiple Desktop instances or cross-window connections may be deployed to the same distro/user simultaneously.
    // Fixed `.new` will overwrite each other's staging files, and the unique owner path ensures that failure cleanup and final rename are not strung together.
    const tempRemotePath = `${params.remotePath}.new-${Date.now()}-${randomUUID()}`;
    this.loggers.log(
      `[remote-assets] uploading ${params.sourceRelativePath} to ${params.remotePath}`,
    );
    const remoteParentDir = posix.dirname(params.remotePath);
    const cleanupRemoteStaging = async (): Promise<void> => {
      try {
        const cleanupStream = await this.backend.exec(`rm -f ${quotePosixPathArg(tempRemotePath)}`);
        await waitForClose(cleanupStream);
      } catch (error) {
        this.loggers.logWarn(
          `[remote-assets] failed to clean owned file staging ${tempRemotePath}: ${String(error)}`,
        );
      }
    };

    try {
      const prepareCommands = [
        ...(this.options.signal
          ? [
              buildStaleRemoteStagingCleanupCommand(remoteParentDir, [
                `${posix.basename(params.remotePath)}.new-*`,
              ]),
            ]
          : []),
        `mkdir -p ${quotePosixPathArg(remoteParentDir)}`,
      ];
      const mkdirStream = await this.backend.exec(prepareCommands.join("\n"));
      await waitForClose(mkdirStream);
      await this.backend.upload(localPath, tempRemotePath, {
        signal: this.options.signal,
      });
      throwIfRemoteAssetInstallAborted(this.options.signal);
      const stream = await this.backend.exec(
        params.executable
          ? buildRemoteExecutableReplaceCommand(tempRemotePath, params.remotePath)
          : buildRemoteMoveCommand(tempRemotePath, params.remotePath),
      );
      await waitForClose(stream);
    } catch (error) {
      // When file replacement fails, the `.new-*` files of the current owner must be cleaned up, otherwise
      // In non-root scenarios, the owner file of the host whose chmod failed will be left on the remote end for a long time.
      // The cancel path may have released the backend and cannot be cleaned up again with the old credentials; it will be recycled by subsequent janitors.
      if (!this.options.signal?.aborted) {
        await cleanupRemoteStaging();
      }
      throw error;
    }
  }

  async installDirectory(params: {
    componentId: string;
    sourceRelativePath: string;
    remoteDir: string;
    requiredRelativePaths?: string[];
    forceRefresh?: boolean;
  }): Promise<void> {
    throwIfRemoteAssetInstallAborted(this.options.signal);
    const localPath = await this.resolveLocalPath(
      [params.componentId],
      params.sourceRelativePath,
      buildRequiredReleasePaths(params.sourceRelativePath, params.requiredRelativePaths),
      Boolean(params.forceRefresh),
    );
    const localTarPath = join(
      tmpdir(),
      `zcode-remote-${params.componentId}-${Date.now()}-${randomUUID()}.tar.gz`,
    );
    await createTarGzArchive(localTarPath, [
      { sourcePath: localPath, archivePath: basename(localPath) },
    ]);

    const ownerSuffix = `${Date.now()}-${randomUUID()}`;
    // Directory upload has reused `<remoteDir>.tar.gz`, and concurrent deployment will overwrite each other’s compressed packages.
    // Even unzip half-written files to the final directory. Archive/extract both have owners, and only clean up their own staging when they fail.
    const remoteTarPath = `${params.remoteDir}.tar.gz-${ownerSuffix}`;
    const remoteExtractDir = `${params.remoteDir}.extract-${ownerSuffix}`;
    const extractedSourceDir = `${remoteExtractDir}/${basename(localPath)}`;
    const cleanupRemoteStaging = async (): Promise<void> => {
      try {
        const cleanupStream = await this.backend.exec(
          `rm -f ${quotePosixPathArg(remoteTarPath)} && rm -rf ${quotePosixPathArg(remoteExtractDir)}`,
        );
        await waitForClose(cleanupStream);
      } catch (error) {
        this.loggers.logWarn(
          `[remote-assets] failed to clean owned directory staging ${ownerSuffix}: ${String(error)}`,
        );
      }
    };

    try {
      // Local archiving does not share the remote life cycle; check again after archiving is completed, and create remote staging after cancellation is prohibited.
      throwIfRemoteAssetInstallAborted(this.options.signal);
      this.loggers.log(
        `[remote-assets] uploading ${params.sourceRelativePath} to ${params.remoteDir}`,
      );
      const remoteParentDir = posix.dirname(params.remoteDir);
      const remoteDirName = posix.basename(params.remoteDir);
      const prepareCommands = [
        ...(this.options.signal
          ? [
              buildStaleRemoteStagingCleanupCommand(remoteParentDir, [
                `${remoteDirName}.tar.gz-*`,
                `${remoteDirName}.extract-*`,
              ]),
            ]
          : []),
        `mkdir -p ${quotePosixPathArg(remoteParentDir)}`,
      ];
      const mkdirStream = await this.backend.exec(prepareCommands.join("\n"));
      await waitForClose(mkdirStream);
      await this.backend.upload(localTarPath, remoteTarPath, {
        signal: this.options.signal,
      });
      throwIfRemoteAssetInstallAborted(this.options.signal);
      const stream = await this.backend.exec(
        [
          "set -eu",
          `cleanup_staging() { rm -f ${quotePosixPathArg(remoteTarPath)}; rm -rf ${quotePosixPathArg(remoteExtractDir)}; }`,
          "trap cleanup_staging EXIT HUP INT TERM",
          `rm -rf ${quotePosixPathArg(remoteExtractDir)}`,
          `mkdir -p ${quotePosixPathArg(remoteExtractDir)} ${quotePosixPathArg(posix.dirname(params.remoteDir))}`,
          `tar -xzf ${quotePosixPathArg(remoteTarPath)} -C ${quotePosixPathArg(remoteExtractDir)}`,
          `test -d ${quotePosixPathArg(extractedSourceDir)}`,
          `rm -rf ${quotePosixPathArg(params.remoteDir)}`,
          buildRemoteMoveCommand(extractedSourceDir, params.remoteDir),
          "cleanup_staging",
          "trap - EXIT HUP INT TERM",
        ].join("\n"),
      );
      await waitForClose(stream);
    } catch (error) {
      // Connection cancellation monitoring will first release the SSH backend; if the same backend is still used to clean up staging later,
      // The SSH implementation may reconnect with old credentials. Canceling the path only retains the unique owner staging and no longer touches the official directory.
      if (!this.options.signal?.aborted) {
        await cleanupRemoteStaging();
      }
      throw error;
    } finally {
      try {
        unlinkSync(localTarPath);
      } catch {
        // Temporary file cleanup failures are ignored and deployment results should not be affected by local cleanup.
      }
    }
  }

  private async tryResolveCdnReleaseDir(
    componentIds: string[],
    requiredReleasePaths?: string[],
    forceRefresh = false,
  ): Promise<string | null> {
    const platformArch = this.options.platformArch?.trim();
    const version = this.options.version?.trim();
    if (!platformArch || !version || !this.options.remoteCacheDir) {
      return null;
    }

    const hasRemoteCdnBase =
      Boolean(this.options.remoteCdnBaseUrl?.trim()) ||
      (this.options.remoteCdnBaseUrls?.some((url) => url.trim().length > 0) ?? false);
    if (!hasRemoteCdnBase) {
      return null;
    }

    try {
      // By default, development mode gives priority to mock-cdn; but users can use remote download first and then switch back to local upload.
      // At this time, mock-cdn may not have corresponding platform/provider resources. The local upload semantics is "upload the resources after obtaining them locally".
      // Therefore, when the local pseudo CDN file is missing, it should fall back to the local cache of the real CDN instead of directly reporting the missing package.
      return await ensureRemoteReleaseDirFromCdn(
        {
          remoteCdnBaseUrl: this.options.remoteCdnBaseUrl,
          remoteCdnBaseUrls: this.options.remoteCdnBaseUrls,
          remoteCacheDir: this.options.remoteCacheDir,
          version,
          platformArch,
          componentIds,
          requiredReleasePaths,
          manifestRequestTimeoutMs: this.options.manifestRequestTimeoutMs,
          remoteAssetNetwork: this.options.remoteAssetNetwork,
          forceRefresh,
        },
        this.loggers,
      );
    } catch (error) {
      this.loggers.logWarn(
        `[remote-assets] local upload CDN fallback failed for ${componentIds.join(",")}: ${String(error)}`,
      );
      // When the App version changes, you must re-obtain the GLM artifact corresponding to the current manifest.
      // If you continue to roll back the old cache after the forced refresh fails, the upload and deployment will appear to be successful but the old resources will still be running on the remote end.
      if (forceRefresh) {
        throw error;
      }
      return null;
    }
  }
}

function buildRequiredReleasePaths(
  sourceRelativePath: string,
  requiredRelativePaths: readonly string[] | undefined,
): string[] {
  const sourcePath = sourceRelativePath.replace(/^\/+|\/+$/gu, "");
  if (!sourcePath) {
    return [];
  }

  const paths = [sourcePath];
  for (const requiredRelativePath of requiredRelativePaths ?? []) {
    const normalizedRequiredPath = requiredRelativePath.replace(/^\/+|\/+$/gu, "");
    if (normalizedRequiredPath) {
      paths.push(posix.join(sourcePath, normalizedRequiredPath));
    }
  }
  return paths;
}

async function findMissingLocalRequiredReleasePaths(
  releaseDir: string,
  requiredReleasePaths: readonly string[] | undefined,
): Promise<string[]> {
  const missingPaths: string[] = [];
  for (const requiredReleasePath of requiredReleasePaths ?? []) {
    const absolutePath = join(releaseDir, requiredReleasePath);
    if (!(await fileExists(absolutePath))) {
      missingPaths.push(absolutePath);
    }
  }
  return missingPaths;
}

export type RemoteManifestRef = RemoteAssetManifestRef;

const remoteDownloadManifestLocks = new Map<string, Promise<RemoteManifestRef>>();

export type RemoteDownloadAssetInstallerOptions = RemoteAssetDeployOptions & {
  version: string;
  platformArch: string;
  remoteCdnBaseUrl?: string;
  remoteCdnBaseUrls?: string[];
  remoteAssetNetwork?: RemoteAssetNetworkPort;
};

interface RemoteComponentRef {
  component: RemoteAssetManifestComponent;
  componentDir: string;
  fromCache: boolean;
}

export class RemoteDownloadAssetInstaller implements RemoteAssetInstaller {
  readonly mode = "remote-download" as const;
  private readonly manifestPromise: Promise<RemoteManifestRef>;
  private readonly componentCache = new Map<string, Promise<RemoteComponentRef>>();
  private readonly forceRefreshComponentTasks = new Map<string, Promise<RemoteComponentRef>>();

  constructor(
    private readonly backend: IRemoteBackend,
    private readonly options: RemoteDownloadAssetInstallerOptions,
    private readonly tools: RemoteAssetTools,
    private readonly loggers: DeployLoggers,
    manifestPromise?: Promise<RemoteManifestRef>,
  ) {
    this.manifestPromise = manifestPromise ?? fetchRemoteDownloadManifest(options, loggers);
  }

  async installFile(params: {
    componentId: string;
    sourceRelativePath: string;
    remotePath: string;
    executable?: boolean;
    forceRefresh?: boolean;
  }): Promise<void> {
    throwIfRemoteAssetInstallAborted(this.options.signal);
    const componentRef = await this.ensureComponent(
      params.componentId,
      [],
      Boolean(params.forceRefresh),
    );
    throwIfRemoteAssetInstallAborted(this.options.signal);
    const sourcePath = buildRemoteComponentSourcePath(componentRef, params.sourceRelativePath);
    const tempPath = `${params.remotePath}.new-${Date.now()}-${randomUUID()}`;
    const stream = await this.backend.exec(
      [
        `mkdir -p ${quotePosixPathArg(posix.dirname(params.remotePath))}`,
        `cp -f ${quotePosixPathArg(sourcePath)} ${quotePosixPathArg(tempPath)}`,
        params.executable
          ? buildRemoteExecutableReplaceCommand(tempPath, params.remotePath)
          : buildRemoteMoveCommand(tempPath, params.remotePath),
      ].join(" && "),
    );
    await waitForClose(stream);
  }

  async installDirectory(params: {
    componentId: string;
    sourceRelativePath: string;
    remoteDir: string;
    requiredRelativePaths?: string[];
    forceRefresh?: boolean;
  }): Promise<void> {
    throwIfRemoteAssetInstallAborted(this.options.signal);
    const componentRef = await this.ensureComponent(
      params.componentId,
      params.requiredRelativePaths,
      Boolean(params.forceRefresh),
    );
    throwIfRemoteAssetInstallAborted(this.options.signal);
    const sourcePath = buildRemoteComponentSourcePath(componentRef, params.sourceRelativePath);
    const stagingDir = `${params.remoteDir}.new-${Date.now()}-${randomUUID()}`;
    // The remove + move of the final directory is serialized by deployServer's install-root transaction lock;
    // UUID staging here takes care of isolating the owner and keeping exception cleanup local.
    const requiredPathChecks = (params.requiredRelativePaths ?? []).map(
      (relativePath) =>
        `test -e ${quotePosixPathArg(`${params.remoteDir}/${relativePath.replace(/^\/+/u, "")}`)}`,
    );
    const stream = await this.backend.exec(
      [
        "set -eu",
        // When copying or eventual replacement fails, the original implementation leaves behind `.new-*` directories permanently.
        // trap only deletes this owner staging and does not touch other concurrent deployers.
        `cleanup_staging() { rm -rf ${quotePosixPathArg(stagingDir)}; }`,
        "trap cleanup_staging EXIT HUP INT TERM",
        `rm -rf ${quotePosixPathArg(stagingDir)}`,
        `mkdir -p ${quotePosixPathArg(stagingDir)} ${quotePosixPathArg(posix.dirname(params.remoteDir))}`,
        `cp -R ${quotePosixPathArg(`${sourcePath}/.`)} ${quotePosixPathArg(stagingDir)}`,
        `rm -rf ${quotePosixPathArg(params.remoteDir)}`,
        buildRemoteMoveCommand(stagingDir, params.remoteDir),
        ...requiredPathChecks,
        "cleanup_staging",
        "trap - EXIT HUP INT TERM",
      ].join("\n"),
    );
    await waitForClose(stream);
  }

  async resolveComponentVersion(componentId: string): Promise<string | null> {
    const manifestRef = await this.manifestPromise;
    return (
      selectRemoteAssetManifestComponents(manifestRef.manifest, [componentId])[0]?.version ?? null
    );
  }

  async resolveComponentSha256(componentId: string): Promise<string | null> {
    const manifestRef = await this.manifestPromise;
    return (
      selectRemoteAssetManifestComponents(manifestRef.manifest, [componentId])[0]?.sha256 ?? null
    );
  }

  private async ensureComponent(
    componentId: string,
    requiredRelativePaths: readonly string[] = [],
    forceRefresh = false,
  ): Promise<RemoteComponentRef> {
    // The GLM bundle comes from the same component as the official plug-in, but the installation will be called twice in sequence.
    // If the forced refresh bypasses the in-process task every time, the same product will be deleted and downloaded twice in succession; the same installer
    // Only force flash once in the life cycle, and allow subsequent mounts to reuse this verified component.
    const existing = forceRefresh
      ? this.forceRefreshComponentTasks.get(componentId)
      : this.componentCache.get(componentId);
    if (existing) {
      const componentRef = await existing;
      return this.ensureComponentHasRequiredPaths(componentRef, requiredRelativePaths);
    }
    const task = this.ensureComponentInternal(componentId, forceRefresh);
    this.componentCache.set(componentId, task);
    if (forceRefresh) {
      this.forceRefreshComponentTasks.set(componentId, task);
    }
    try {
      const componentRef = await task;
      return this.ensureComponentHasRequiredPaths(componentRef, requiredRelativePaths);
    } catch (error) {
      if (this.componentCache.get(componentId) === task) {
        this.componentCache.delete(componentId);
      }
      if (this.forceRefreshComponentTasks.get(componentId) === task) {
        this.forceRefreshComponentTasks.delete(componentId);
      }
      throw error;
    }
  }

  private async ensureComponentHasRequiredPaths(
    componentRef: RemoteComponentRef,
    requiredRelativePaths: readonly string[],
  ): Promise<RemoteComponentRef> {
    if (requiredRelativePaths.length === 0) {
      return componentRef;
    }

    const missingPaths = await this.findMissingComponentPaths(
      componentRef.componentDir,
      requiredRelativePaths,
    );
    if (missingPaths.length === 0 || !componentRef.fromCache) {
      return componentRef;
    }

    // The key of the remote component cache is only hit according to the semantic version; if the historical component cache lacks the key file,
    // The deployment layer will repeatedly copy the incomplete cache back to the running directory.
    // Here, after the cache hit, the key files declared by the caller are checked for integrity. If missing, the old ready/cache is cleared and the component is forced to be downloaded again.
    this.loggers.logWarn(
      `[remote-assets] remote component cache incomplete: component=${componentRef.component.id} missing=${missingPaths.join(",")}; redownloading`,
    );
    await this.removeRemoteComponentCache(componentRef.componentDir);
    const task = this.ensureComponentInternal(componentRef.component.id);
    this.componentCache.set(componentRef.component.id, task);
    return await task;
  }

  private async findMissingComponentPaths(
    componentDir: string,
    requiredRelativePaths: readonly string[],
  ): Promise<string[]> {
    const missingPaths: string[] = [];
    for (const relativePath of requiredRelativePaths) {
      const remotePath = `${componentDir}/${relativePath.replace(/^\/+/u, "")}`;
      if (!(await this.backend.exists(remotePath))) {
        missingPaths.push(remotePath);
      }
    }
    return missingPaths;
  }

  private async removeRemoteComponentCache(componentDir: string): Promise<void> {
    const stream = await this.backend.exec(`rm -rf ${quotePosixPathArg(componentDir)}`);
    await waitForClose(stream);
  }

  private async ensureComponentInternal(
    componentId: string,
    forceRefresh = false,
  ): Promise<RemoteComponentRef> {
    const manifestRef = await this.manifestPromise;
    const component = selectRemoteAssetManifestComponents(manifestRef.manifest, [componentId])[0];
    if (!component) {
      throw new Error(`[remote-assets] manifest is missing requested component: ${componentId}`);
    }

    // Both server-bundle and GLM allow the semantic version to remain unchanged but the artifact content to be updated, cache
    // It must be isolated directly by manifest SHA; other resource packages continue to use the original semantic version key.
    const componentCacheSegment = usesRemoteAssetContentAddressedCacheIdentity(component.id)
      ? component.sha256
      : hashRemoteCacheSegment(resolveRemoteAssetComponentCacheVersion(component.version));
    const componentDir = `${REMOTE_BASE}/asset-cache/components/${quoteSafeSegment(this.options.platformArch)}/${quoteSafeSegment(component.id)}/${componentCacheSegment}`;
    const readyPath = `${componentDir}/.ready`;
    if (await this.backend.exists(readyPath)) {
      if (forceRefresh) {
        // Force deployment requires an actual re-download of the artifact: even if the cache directory is quarantined by manifest SHA,
        // When ready is hit, it must be cleared first, otherwise it will return early and treat the existing cache as the result of this deployment.
        this.loggers.logWarn(
          `[remote-assets] download required: component=${component.id} reason=force refresh path=${readyPath}`,
        );
        await this.removeRemoteComponentCache(componentDir);
      } else {
        this.loggers.log(
          `[remote-assets] remote component cache hit: ${component.id}@${component.version}`,
        );
        return { component, componentDir, fromCache: true };
      }
    }

    if (!forceRefresh) {
      this.loggers.logWarn(
        `[remote-assets] download required: component=${component.id} reason=remote component cache missing path=${readyPath}`,
      );
    }
    const artifactUrls = buildComponentArtifactUrlCandidates(
      manifestRef.releaseBaseCandidatesForComponents,
      component.artifactPath,
      this.options.version,
    );
    const totalBytes = await resolveRemoteArtifactContentLength(
      artifactUrls,
      this.options.remoteAssetNetwork,
    );
    // HEAD only serves progress statistics and is allowed to end independently; the connection life cycle must be rechecked after completion.
    // Disable late continuations after cancellation using the old backend to create remote downloads and staging.
    throwIfRemoteAssetInstallAborted(this.options.signal);
    const stagingDir = `${REMOTE_BASE}/asset-cache/staging/${quoteSafeSegment(component.id)}-${Date.now()}-${randomUUID()}`;
    const archivePath = `${stagingDir}/component.tar.gz`;
    const extractDir = `${stagingDir}/extract`;
    const componentNewDir = `${componentDir}.new-${Date.now()}-${randomUUID()}`;
    const lockDir = `${componentDir}.lock`;
    const quotedLockDir = quotePosixPathArg(lockDir);
    const cleanupCommand = `if [ -n "\${lock_heartbeat_pid:-}" ]; then kill "$lock_heartbeat_pid" >/dev/null 2>&1 || true; wait "$lock_heartbeat_pid" 2>/dev/null || true; fi; rm -rf ${quotedLockDir} ${quotePosixPathArg(stagingDir)} ${quotePosixPathArg(componentNewDir)}`;
    const downloadCommand = buildRemoteArtifactDownloadCommand({
      tool: this.tools.download,
      urls: artifactUrls,
      outputPath: archivePath,
      progressLabel: `${component.id}@${component.version}`,
      totalBytes,
      expectedSha256: component.sha256,
      sha256Tool: this.tools.sha256,
    });
    const checksumCommand = buildRemoteChecksumCommand({
      tool: this.tools.sha256,
      filePath: archivePath,
    });
    const checksumMismatchMessage = `[remote-assets] sha256 mismatch for ${component.id}@${component.version}`;
    const command = [
      "set -eu",
      `rm -rf ${quotePosixPathArg(stagingDir)}`,
      `mkdir -p ${quotePosixPathArg(stagingDir)} ${quotePosixPathArg(posix.dirname(componentDir))}`,
      // Interruption of remote downloads may leave the .lock directory behind. The lock-holding process refreshes mtime regularly, and the waiting party only clears locks that have not had a heartbeat for more than 10 minutes.
      // This prevents the user from waiting when selecting the remote download again after disconnecting, and at the same time does not accidentally damage the normal process of slow downloading.
      `while ! mkdir ${quotedLockDir} 2>/dev/null; do if [ -e ${quotePosixPathArg(readyPath)} ]; then rm -rf ${quotePosixPathArg(stagingDir)}; exit 0; fi; lock_mtime=$({ stat -c %Y ${quotedLockDir} || stat -f %m ${quotedLockDir}; } 2>/dev/null || printf 0); lock_now=$(date +%s); if [ "$lock_mtime" -gt 0 ] && [ $((lock_now - lock_mtime)) -ge 600 ]; then echo ${quotePosixShellArg(`[remote-assets] stale lock for ${component.id}@${component.version}, retrying`)} >&2; rm -rf ${quotedLockDir}; continue; fi; sleep 1; done`,
      `lock_heartbeat_pid=; (while :; do touch ${quotedLockDir} 2>/dev/null || exit 0; sleep 30; done) & lock_heartbeat_pid=$!`,
      `trap ${quotePosixShellArg(cleanupCommand)} EXIT`,
      `if [ -e ${quotePosixPathArg(readyPath)} ]; then exit 0; fi`,
      downloadCommand,
      `actual_sha=$(${checksumCommand})`,
      `if [ "$actual_sha" != ${quotePosixShellArg(component.sha256)} ]; then echo ${quotePosixShellArg(checksumMismatchMessage)} >&2; exit 1; fi`,
      `mkdir -p ${quotePosixPathArg(extractDir)}`,
      `${this.tools.tar} -xzf ${quotePosixPathArg(archivePath)} -C ${quotePosixPathArg(extractDir)}`,
      `test "$(find ${quotePosixPathArg(extractDir)} -mindepth 1 -maxdepth 1 | head -n 1)"`,
      `printf ready > ${quotePosixPathArg(`${extractDir}/.ready`)}`,
      `rm -rf ${quotePosixPathArg(componentNewDir)}`,
      buildRemoteMoveCommand(extractDir, componentNewDir),
      `rm -rf ${quotePosixPathArg(componentDir)}`,
      buildRemoteMoveCommand(componentNewDir, componentDir),
      cleanupCommand,
      "trap - EXIT",
    ].join(" && ");

    this.loggers.log(`[remote-assets] remote downloading ${component.id}@${component.version}`);
    const stream = await this.backend.exec(command);
    forwardRemoteDownloadProgressLogs(stream, this.loggers);
    await waitForClose(stream);
    return { component, componentDir, fromCache: false };
  }
}

export async function fetchRemoteDownloadManifest(
  options: RemoteDownloadAssetInstallerOptions,
  loggers: DeployLoggers,
): Promise<RemoteManifestRef> {
  const remoteCdnBaseUrls = resolveRemoteCdnBaseUrls({
    remoteCdnBaseUrl: options.remoteCdnBaseUrl,
    remoteCdnBaseUrls: options.remoteCdnBaseUrls,
  });
  const lockKey = [
    options.version,
    options.platformArch,
    String(options.manifestRequestTimeoutMs ?? "default"),
    ...remoteCdnBaseUrls,
  ].join("::");
  const lockedTask = remoteDownloadManifestLocks.get(lockKey);
  if (lockedTask) {
    return lockedTask;
  }

  let task: Promise<RemoteManifestRef>;
  task = fetchRemoteDownloadManifestInternal(options, remoteCdnBaseUrls, loggers).finally(() => {
    if (remoteDownloadManifestLocks.get(lockKey) === task) {
      remoteDownloadManifestLocks.delete(lockKey);
    }
  });
  remoteDownloadManifestLocks.set(lockKey, task);
  return task;
}

async function fetchRemoteDownloadManifestInternal(
  options: RemoteDownloadAssetInstallerOptions,
  remoteCdnBaseUrls: string[],
  loggers: DeployLoggers,
): Promise<RemoteManifestRef> {
  const releaseBaseCandidates = buildReleaseBaseCandidates(remoteCdnBaseUrls, options.version);
  const manifestUrls = buildReleaseAssetUrlCandidates(
    releaseBaseCandidates,
    buildRemoteAssetManifestFileCandidates(options.platformArch),
  );
  const candidateErrors: string[] = [];

  for (const url of manifestUrls) {
    loggers.log(`[remote-assets] downloading manifest ${url}`);
    const signal = createRemoteAssetManifestRequestSignal(options.manifestRequestTimeoutMs);
    let response: Response;
    try {
      response = await resolveRemoteAssetFetch(options.remoteAssetNetwork)(url, {
        signal,
      });
    } catch (error) {
      candidateErrors.push(`${url} -> ${String(error)}`);
      loggers.logWarn(`[remote-assets] manifest candidate failed ${url}: ${String(error)}`);
      continue;
    }
    if (!response.ok) {
      if (response.status !== 404) {
        candidateErrors.push(`${url} -> HTTP ${response.status}`);
      }
      continue;
    }

    let manifest: RemoteAssetManifest;
    try {
      manifest = await parseRemoteAssetManifestFromResponse(
        response,
        url,
        options.version,
        options.platformArch,
      );
    } catch (error) {
      if (!signal.aborted) {
        throw error;
      }
      // The success of the manifest response header does not mean the end of the response experience; the body must be
      // Cancel the current request and try the next CDN to avoid remote-download initialization hanging permanently.
      loggers.logWarn(`[remote-assets] manifest candidate failed ${url}: ${String(error)}`);
      candidateErrors.push(`${url} -> ${String(error)}`);
      continue;
    }
    const manifestReleaseBase = resolveReleaseBaseByAssetUrl(url, releaseBaseCandidates);
    return {
      manifest,
      releaseBaseCandidatesForComponents: manifestReleaseBase
        ? [
            manifestReleaseBase,
            ...releaseBaseCandidates.filter((candidate) => candidate !== manifestReleaseBase),
          ]
        : releaseBaseCandidates,
    };
  }

  if (candidateErrors.length > 0) {
    // remote-download used to drop timeout/HTTP diagnostics for each CDN candidate,
    // In the end, only manifest not found is reported, and it is impossible to distinguish between unpublished resources and half-open response bodies.
    throw new Error(
      `[remote-assets] failed to fetch manifest for ${options.platformArch}: ${candidateErrors.join("; ")}`,
    );
  }
  throw new Error(`[remote-assets] manifest not found for ${options.platformArch}`);
}

function buildRemoteComponentSourcePath(
  ref: RemoteComponentRef,
  releaseRelativePath: string,
): string {
  const mount = ref.component.mount.replace(/\/+$/u, "");
  const normalizedSource = releaseRelativePath.replace(/^\/+|\/+$/gu, "");
  const relativeInsideComponent =
    normalizedSource === mount
      ? "."
      : normalizedSource.startsWith(`${mount}/`)
        ? normalizedSource.slice(mount.length + 1)
        : normalizedSource;
  return relativeInsideComponent === "."
    ? `${ref.componentDir}/.`
    : `${ref.componentDir}/${relativeInsideComponent}`;
}

function resolveReleaseBaseByAssetUrl(
  assetUrl: string,
  releaseBaseCandidates: string[],
): string | null {
  const matchedReleaseBases = releaseBaseCandidates
    .map((releaseBase) => releaseBase.replace(/\/+$/u, ""))
    .filter((releaseBase) => releaseBase.length > 0 && assetUrl.startsWith(`${releaseBase}/`))
    .sort((left, right) => right.length - left.length);
  return matchedReleaseBases[0] ?? null;
}

async function resolveRemoteArtifactContentLength(
  urls: string[],
  network?: RemoteAssetNetworkPort,
): Promise<number | null> {
  const fetchImpl = resolveRemoteAssetFetch(network);
  for (const url of urls) {
    try {
      const response = await fetchImpl(url, { method: "HEAD" });
      if (!response.ok) {
        continue;
      }
      const contentLength = parseContentLength(response.headers.get("content-length"));
      if (contentLength != null) {
        return contentLength;
      }
    } catch {
      // HEAD is only used for the connection log progress total; the download itself continues to execute according to the curl/wget candidate when it fails.
    }
  }
  return null;
}

function parseContentLength(contentLengthHeader: string | null): number | null {
  if (!contentLengthHeader) {
    return null;
  }
  const parsed = Number.parseInt(contentLengthHeader, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function quoteSafeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._+-]/gu, "_");
}

function hashRemoteCacheSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function forwardRemoteDownloadProgressLogs(stream: StdioStream, loggers: DeployLoggers): void {
  let bufferedStdout = "";
  stream.stdout.on("data", (chunk: Buffer | string) => {
    bufferedStdout += chunk.toString();
    const lines = bufferedStdout.split(/\r?\n/u);
    bufferedStdout = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^download progress:/iu.test(trimmed)) {
        loggers.log(trimmed);
      }
    }
  });
  stream.onClose(() => {
    const trimmed = bufferedStdout.trim();
    if (/^download progress:/iu.test(trimmed)) {
      loggers.log(trimmed);
    }
  });
}
