/* eslint-disable max-lines */
import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  createReadStream,
  createWriteStream,
  type Dirent,
} from "node:fs";
import {
  copyFile,
  link,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileExists } from "@zcode/server/remote/deployShared.js";
import { extractTarGzArchive } from "@zcode/server/remote/localTarGz.js";
import {
  assertRemoteCdnBaseVersionMatches,
  buildComponentArtifactUrlCandidates,
  buildReleaseAssetUrlCandidates,
  buildReleaseBaseCandidates,
  normalizeRemoteAssetRelativePath,
  resolveRemoteCdnBaseUrls,
} from "@zcode/server/remote/remoteAssetCdn.js";
import {
  resolveRemoteAssetFetch,
  type RemoteAssetNetworkPort,
} from "@zcode/server/remote/remoteAssetNetwork.js";

const MANIFEST_FILE_NAME_PREFIX = "manifest-";
const REMOTE_ASSET_READY_MARKER = ".ready";
const LEGACY_REMOTE_ASSET_READY_MARKER = ".remote-assets-ready";
const READY_MARKER_CANDIDATES = [REMOTE_ASSET_READY_MARKER, LEGACY_REMOTE_ASSET_READY_MARKER];
const remoteAssetReleaseLocks = new Map<string, Promise<string>>();
const remoteAssetManifestLocks = new Map<string, Promise<RemoteAssetManifestFetchResult | null>>();
const remoteAssetManifestRefreshLocks = new Map<
  string,
  Promise<RemoteAssetManifestFetchResult | null>
>();
const remoteAssetComponentLocks = new Map<string, Promise<string>>();
const remoteAssetReleaseMaterializeLocks = new Map<string, Promise<void>>();
const DEFAULT_REMOTE_ASSET_MANIFEST_REQUEST_TIMEOUT_MS = 10_000;
const REMOTE_ASSET_PROGRESS_INTERVAL_MS = 1_000;
const REMOTE_ASSET_PROGRESS_PERCENT_STEP = 5;
const CONTENT_ADDRESSED_COMPONENT_RELEASE_DIRS: Record<string, string> = {
  "server-bundle": "server-content",
  glm: "glm-content",
};
const REMOTE_ASSET_DIRECTORY_COMMIT_RETRY_DELAYS_MS = [
  50, 100, 200, 400, 800, 1_600, 3_200,
] as const;

export interface RemoteAssetManifest {
  schemaVersion: number;
  appVersion: string;
  platformArch: string;
  components: RemoteAssetManifestComponent[];
}

export interface RemoteAssetManifestComponent {
  id: string;
  version: string;
  sha256: string;
  artifactPath: string;
  mount: string;
}

export interface RemoteAssetManifestRef {
  manifest: RemoteAssetManifest;
  releaseBaseCandidatesForComponents: string[];
}

type RemoteAssetManifestFetchResult = RemoteAssetManifestRef;

interface ComponentMountRule {
  platformScoped: boolean;
  resolveExpectedMount: (platformArch: string) => string;
}

const REMOTE_COMPONENT_MOUNT_RULES: Record<string, ComponentMountRule> = {
  "server-bundle": {
    platformScoped: false,
    resolveExpectedMount: () => "server",
  },
  "node-runtime": {
    platformScoped: true,
    resolveExpectedMount: (platformArch) => `node/${platformArch}`,
  },
  "node-pty": {
    platformScoped: true,
    resolveExpectedMount: (platformArch) => `node-pty/${platformArch}`,
  },
  glm: {
    platformScoped: true,
    resolveExpectedMount: (platformArch) => `glm/${platformArch}`,
  },
  bfs: {
    platformScoped: true,
    resolveExpectedMount: (platformArch) => `tools/${platformArch}/bfs`,
  },
  ripgrep: {
    platformScoped: true,
    resolveExpectedMount: (platformArch) => `tools/${platformArch}/ripgrep`,
  },
  ugrep: {
    platformScoped: true,
    resolveExpectedMount: (platformArch) => `tools/${platformArch}/ugrep`,
  },
};

export interface RemoteAssetCacheLoggers {
  log: (...args: unknown[]) => void;
  logWarn: (...args: unknown[]) => void;
}

export interface EnsureRemoteReleaseDirOptions {
  remoteCdnBaseUrl?: string;
  remoteCdnBaseUrls?: string[];
  remoteCacheDir?: string;
  version: string;
  platformArch: string;
  componentIds?: string[];
  requiredReleasePaths?: string[];
  /**
   * Bind identity decisions and actual materialization to the same manifest snapshot.
   * Null means that this transaction has confirmed that the manifest is missing and cannot be requested again.
   */
  manifestRef?: RemoteAssetManifestRef | null;
  /** Only used for identity checks that need to observe re-issuance of products with the same app version. */
  refreshManifest?: boolean;
  /** Ignore the current content addressing cache and re-download and verify the selected components. */
  forceRefresh?: boolean;
  /** Timeout for a single manifest CDN candidate request. */
  manifestRequestTimeoutMs?: number;
  remoteAssetNetwork?: RemoteAssetNetworkPort;
}

export function createRemoteAssetManifestRequestSignal(
  timeoutMs = DEFAULT_REMOTE_ASSET_MANIFEST_REQUEST_TIMEOUT_MS,
): AbortSignal {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `[remote-assets] manifest request timeout must be a positive safe integer: ${String(timeoutMs)}`,
    );
  }
  // Manifest is the pre-input for server-bundle/GLM SHA skip judgment; if the network is half open, if it is not actively canceled,
  // The fully deployed remote end will also be permanently stuck in initialization, and single-flight will tie subsequent connections to the same pending request.
  return AbortSignal.timeout(timeoutMs);
}

export async function ensureRemoteReleaseDirFromCdn(
  options: EnsureRemoteReleaseDirOptions,
  loggers: RemoteAssetCacheLoggers,
): Promise<string> {
  const remoteCdnBaseUrls = resolveRemoteCdnBaseUrls(options);
  const remoteCacheDir = options.remoteCacheDir?.trim();
  const platformArch = options.platformArch?.trim();
  const version = options.version?.trim();

  if (remoteCdnBaseUrls.length === 0 || !remoteCacheDir || !platformArch || !version) {
    throw new Error(
      `[deploy] production remote assets require remoteCdnBaseUrl or remoteCdnBaseUrls, remoteCacheDir and platformArch ` +
        `(remoteCdnBaseUrl=${options.remoteCdnBaseUrl ?? "<empty>"}, remoteCdnBaseUrls=${JSON.stringify(options.remoteCdnBaseUrls ?? [])}, remoteCacheDir=${options.remoteCacheDir ?? "<empty>"}, platformArch=${options.platformArch ?? "<empty>"}).`,
    );
  }

  assertSafePathSegment(version, "appVersion");
  assertSafePathSegment(platformArch, "platformArch");
  assertRemoteCdnBaseVersionMatches(remoteCdnBaseUrls, version);
  const requestedComponentIds = normalizeRequestedComponentIds(options.componentIds);
  const usesContentAddressedArtifactIdentity =
    requestedComponentIds === null ||
    Array.from(requestedComponentIds).some((componentId) =>
      usesRemoteAssetContentAddressedCacheIdentity(componentId),
    );
  const requiredReleasePaths = normalizeRequiredReleasePaths(options.requiredReleasePaths);

  // Previously, cache directories were only differentiated by version, and cross-platform remote sessions would overwrite each other's resources.
  // This is changed to version + platformArch dual-dimensional isolation to avoid linux/darwin cross-talk leading to deployment binary mismatch.
  const releaseDir = join(remoteCacheDir, "releases", version, platformArch);
  if (
    !options.forceRefresh &&
    !usesContentAddressedArtifactIdentity &&
    (await isReadyReleaseDirForRequestedPaths(releaseDir, platformArch, requiredReleasePaths))
  ) {
    return releaseDir;
  }
  loggers.logWarn(
    `[remote-assets] download required: component=<release> reason=local cache missing or invalid path=${releaseDir}`,
  );

  // The same desktop window can create multiple remote sessions concurrently.
  // If no in-process lock is added, multiple sessions will download and decompress the same version of resources at the same time, eventually overwriting each other or leaving a semi-finished directory.
  // Previously, the lock key did not include remoteCacheDir, and different cache directories would mistakenly reuse the same Promise.
  // This will return the release path of directory A to the caller B, destroying cache isolation semantics.
  const requestedComponentLockKey = requestedComponentIds
    ? Array.from(requestedComponentIds).sort().join(",")
    : "<all>";
  const pinnedContentIdentity = usesContentAddressedArtifactIdentity
    ? resolveContentAddressedReleaseSegments(
        options.manifestRef
          ? selectManifestComponents(options.manifestRef.manifest, requestedComponentIds)
          : [],
        requestedComponentIds,
      ).join("/")
    : undefined;
  const lockKey = [
    resolve(releaseDir),
    requestedComponentLockKey,
    options.manifestRef === null ? "<missing-manifest>" : pinnedContentIdentity || "<unpinned>",
    options.forceRefresh ? "force" : "reuse",
    String(options.manifestRequestTimeoutMs ?? "default"),
  ].join("::");
  while (true) {
    const lockedTask = remoteAssetReleaseLocks.get(lockKey);
    if (!lockedTask) {
      break;
    }
    const lockedReleaseDir = await lockedTask;
    const missingPaths = await findMissingLocalRelativePaths(
      lockedReleaseDir,
      requiredReleasePaths,
    );
    if (missingPaths.length === 0) {
      return lockedReleaseDir;
    }
    // Concurrent remote sessions may first reuse a release download lock "without required paths".
    // After waiting for the lock to be completed, it must be rechecked according to the critical path declared by the current caller. If it is missing, continue to follow the subsequent re-download process.
    loggers.logWarn(
      `[remote-assets] locked release cache still incomplete: missing=${missingPaths.join(",")}; redownloading`,
    );
  }

  const task = ensureRemoteReleaseDirFromCdnInternal(
    {
      remoteCdnBaseUrls,
      remoteCacheDir,
      version,
      platformArch,
      requestedComponentIds,
      requiredReleasePaths,
      manifestRef: options.manifestRef,
      forceRefresh: options.forceRefresh,
      manifestRequestTimeoutMs: options.manifestRequestTimeoutMs,
      remoteAssetNetwork: options.remoteAssetNetwork,
    },
    loggers,
  ).finally(() => {
    remoteAssetReleaseLocks.delete(lockKey);
  });

  remoteAssetReleaseLocks.set(lockKey, task);
  return task;
}

export async function fetchRemoteAssetManifestFromCdn(
  options: EnsureRemoteReleaseDirOptions,
  loggers: RemoteAssetCacheLoggers,
): Promise<RemoteAssetManifest | null> {
  return (await fetchRemoteAssetManifestRefFromCdn(options, loggers))?.manifest ?? null;
}

export async function fetchRemoteAssetManifestRefFromCdn(
  options: EnsureRemoteReleaseDirOptions,
  loggers: RemoteAssetCacheLoggers,
): Promise<RemoteAssetManifestRef | null> {
  const remoteCdnBaseUrls = resolveRemoteCdnBaseUrls(options);
  const remoteCacheDir = options.remoteCacheDir?.trim();
  const platformArch = options.platformArch?.trim();
  const version = options.version?.trim();

  if (remoteCdnBaseUrls.length === 0 || !remoteCacheDir || !platformArch || !version) {
    return null;
  }

  assertSafePathSegment(version, "appVersion");
  assertSafePathSegment(platformArch, "platformArch");
  assertRemoteCdnBaseVersionMatches(remoteCdnBaseUrls, version);

  const releaseBaseCandidates = buildReleaseBaseCandidates(remoteCdnBaseUrls, version);
  const manifestFileCandidates = buildRemoteManifestFileCandidates(platformArch);
  const manifestFileName =
    manifestFileCandidates[0] ?? `${MANIFEST_FILE_NAME_PREFIX}${platformArch}.json`;
  const manifestUrlCandidates = buildReleaseAssetUrlCandidates(
    releaseBaseCandidates,
    manifestFileCandidates,
  );

  const result = await fetchRemoteAssetManifest(
    {
      remoteCacheDir,
      version,
      platformArch,
      remoteCdnBaseUrls,
      releaseBaseCandidates,
      manifestUrlCandidates,
      manifestFileName,
      manifestRequestTimeoutMs: options.manifestRequestTimeoutMs,
      remoteAssetNetwork: options.remoteAssetNetwork,
    },
    loggers,
    options.refreshManifest ? async () => true : undefined,
  );
  return result;
}

async function ensureRemoteReleaseDirFromCdnInternal(
  options: {
    remoteCdnBaseUrls: string[];
    remoteCacheDir: string;
    version: string;
    platformArch: string;
    requestedComponentIds: Set<string> | null;
    requiredReleasePaths: string[];
    manifestRef?: RemoteAssetManifestRef | null;
    forceRefresh?: boolean;
    manifestRequestTimeoutMs?: number;
    remoteAssetNetwork?: RemoteAssetNetworkPort;
  },
  loggers: RemoteAssetCacheLoggers,
): Promise<string> {
  const usesContentAddressedArtifactIdentity =
    options.requestedComponentIds === null ||
    Array.from(options.requestedComponentIds).some((componentId) =>
      usesRemoteAssetContentAddressedCacheIdentity(componentId),
    );
  const releaseDir = join(
    options.remoteCacheDir,
    "releases",
    options.version,
    options.platformArch,
  );
  if (
    !options.forceRefresh &&
    !usesContentAddressedArtifactIdentity &&
    (await isReadyReleaseDirForRequestedPaths(
      releaseDir,
      options.platformArch,
      options.requiredReleasePaths,
    ))
  ) {
    return releaseDir;
  }

  const releaseBaseCandidates = buildReleaseBaseCandidates(
    options.remoteCdnBaseUrls,
    options.version,
  );
  const manifestFileCandidates = buildRemoteManifestFileCandidates(options.platformArch);
  const manifestFileName =
    manifestFileCandidates[0] ?? `${MANIFEST_FILE_NAME_PREFIX}${options.platformArch}.json`;
  const manifestUrlCandidates = buildReleaseAssetUrlCandidates(
    releaseBaseCandidates,
    manifestFileCandidates,
  );
  if (options.manifestRef) {
    return ensureRemoteReleaseDirFromManifest(
      {
        remoteCacheDir: options.remoteCacheDir,
        version: options.version,
        platformArch: options.platformArch,
        releaseBaseCandidatesForComponents: options.manifestRef.releaseBaseCandidatesForComponents,
        requestedComponentIds: options.requestedComponentIds,
        requiredReleasePaths: options.requiredReleasePaths,
        forceRefresh: options.forceRefresh,
        remoteAssetNetwork: options.remoteAssetNetwork,
      },
      options.manifestRef.manifest,
      loggers,
    );
  }
  if (options.manifestRef === null) {
    // Upstream has fixed the "manifest missing" result within deploy lock;
    // If release materialize is requested again, the single transaction snapshot will be destroyed and the timeout limit will be doubled.
    throw new Error(
      `[remote-assets] manifest not found for ${options.platformArch}: ${manifestFileName}`,
    );
  }

  const manifestFetchResult = await fetchRemoteAssetManifest(
    {
      remoteCacheDir: options.remoteCacheDir,
      version: options.version,
      platformArch: options.platformArch,
      remoteCdnBaseUrls: options.remoteCdnBaseUrls,
      releaseBaseCandidates,
      manifestUrlCandidates,
      manifestFileName,
      manifestRequestTimeoutMs: options.manifestRequestTimeoutMs,
      remoteAssetNetwork: options.remoteAssetNetwork,
    },
    loggers,
    usesContentAddressedArtifactIdentity
      ? async (cachedResult) => {
          const cachedComponents = selectManifestComponents(
            cachedResult.manifest,
            options.requestedComponentIds,
          );
          const contentSegments = resolveContentAddressedReleaseSegments(
            cachedComponents,
            options.requestedComponentIds,
          );
          return contentSegments.length > 0
            ? pathExists(
                join(
                  options.remoteCacheDir,
                  "releases",
                  options.version,
                  options.platformArch,
                  ...contentSegments,
                  `${MANIFEST_FILE_NAME_PREFIX}${options.platformArch}.json`,
                ),
              )
            : false;
        }
      : undefined,
  );
  if (manifestFetchResult) {
    return ensureRemoteReleaseDirFromManifest(
      {
        remoteCacheDir: options.remoteCacheDir,
        version: options.version,
        platformArch: options.platformArch,
        releaseBaseCandidatesForComponents: manifestFetchResult.releaseBaseCandidatesForComponents,
        requestedComponentIds: options.requestedComponentIds,
        requiredReleasePaths: options.requiredReleasePaths,
        forceRefresh: options.forceRefresh,
        remoteAssetNetwork: options.remoteAssetNetwork,
      },
      manifestFetchResult.manifest,
      loggers,
    );
  }

  // Now the production state only publishes manifest/components. The missing manifest indicates that the CDN release is incomplete.
  // Continuing to probe for old remote-assets will only increase invalid requests and mask real publishing issues.
  throw new Error(
    `[remote-assets] manifest not found for ${options.platformArch}: ${manifestFileName}`,
  );
}

async function fetchRemoteAssetManifest(
  options: {
    remoteCacheDir: string;
    version: string;
    platformArch: string;
    remoteCdnBaseUrls: string[];
    releaseBaseCandidates: string[];
    manifestUrlCandidates: string[];
    manifestFileName: string;
    manifestRequestTimeoutMs?: number;
    remoteAssetNetwork?: RemoteAssetNetworkPort;
  },
  loggers: RemoteAssetCacheLoggers,
  shouldRefreshCachedResult?: (result: RemoteAssetManifestFetchResult) => Promise<boolean>,
): Promise<RemoteAssetManifestFetchResult | null> {
  const lockKey = [
    resolve(options.remoteCacheDir),
    options.version,
    options.platformArch,
    String(options.manifestRequestTimeoutMs ?? "default"),
    ...options.remoteCdnBaseUrls,
  ].join("::");
  const lockedTask = remoteAssetManifestLocks.get(lockKey);
  if (lockedTask) {
    const activeRefreshTask = remoteAssetManifestRefreshLocks.get(lockKey);
    if (activeRefreshTask) {
      return activeRefreshTask;
    }
    const cachedResult = await lockedTask;
    const refreshStartedWhileWaiting = remoteAssetManifestRefreshLocks.get(lockKey);
    if (refreshStartedWhileWaiting) {
      return refreshStartedWhileWaiting;
    }
    const shouldRefresh = Boolean(
      cachedResult && shouldRefreshCachedResult && (await shouldRefreshCachedResult(cachedResult)),
    );
    if (!shouldRefresh) {
      return cachedResult;
    }
    const refreshStartedWhileDeciding = remoteAssetManifestRefreshLocks.get(lockKey);
    if (refreshStartedWhileDeciding) {
      return refreshStartedWhileDeciding;
    }
  }

  let task: Promise<RemoteAssetManifestFetchResult | null>;
  task = fetchRemoteAssetManifestInternal(options, loggers).then(
    (result) => {
      if (!result && remoteAssetManifestLocks.get(lockKey) === task) {
        remoteAssetManifestLocks.delete(lockKey);
      }
      return result;
    },
    (error) => {
      if (remoteAssetManifestLocks.get(lockKey) === task) {
        remoteAssetManifestLocks.delete(lockKey);
      }
      throw error;
    },
  );
  remoteAssetManifestLocks.set(lockKey, task);
  if (shouldRefreshCachedResult) {
    // Multiple remote sessions may check the SHA of the content-addressed component simultaneously. fresh manifest is also required
    // single-flight, otherwise the same batch of sessions will be repeatedly requested, and even different snapshots will be seen at the publishing switch point.
    remoteAssetManifestRefreshLocks.set(lockKey, task);
    void task.then(
      () => {
        if (remoteAssetManifestRefreshLocks.get(lockKey) === task) {
          remoteAssetManifestRefreshLocks.delete(lockKey);
        }
      },
      () => {
        if (remoteAssetManifestRefreshLocks.get(lockKey) === task) {
          remoteAssetManifestRefreshLocks.delete(lockKey);
        }
      },
    );
  }
  return task;
}

async function fetchRemoteAssetManifestInternal(
  options: {
    version: string;
    platformArch: string;
    releaseBaseCandidates: string[];
    manifestUrlCandidates: string[];
    manifestFileName: string;
    manifestRequestTimeoutMs?: number;
    remoteAssetNetwork?: RemoteAssetNetworkPort;
  },
  loggers: RemoteAssetCacheLoggers,
): Promise<RemoteAssetManifestFetchResult | null> {
  const manifestFetchResult = await fetchFirstAvailableManifestOrNullWhenNotFound({
    candidates: options.manifestUrlCandidates,
    fileLabel: options.manifestFileName,
    version: options.version,
    platformArch: options.platformArch,
    manifestRequestTimeoutMs: options.manifestRequestTimeoutMs,
    fetch: resolveRemoteAssetFetch(options.remoteAssetNetwork),
  });
  if (!manifestFetchResult) {
    return null;
  }

  loggers.log(`[remote-assets] downloading ${manifestFetchResult.url}`);
  const manifestReleaseBase = resolveReleaseBaseByAssetUrl(
    manifestFetchResult.url,
    options.releaseBaseCandidates,
  );
  // After component-level on-demand download, releaseDir will be requested multiple times for the same deployment.
  // The manifest is cached here, and the CDN source hit by the manifest is continued to be used first to avoid repeated pulling of manifests and inconsistencies in cross-origin components.
  const releaseBaseCandidatesForComponents = manifestReleaseBase
    ? [
        manifestReleaseBase,
        ...options.releaseBaseCandidates.filter((candidate) => candidate !== manifestReleaseBase),
      ]
    : options.releaseBaseCandidates;

  return {
    manifest: manifestFetchResult.manifest,
    releaseBaseCandidatesForComponents,
  };
}

async function ensureRemoteReleaseDirFromManifest(
  options: {
    remoteCacheDir: string;
    version: string;
    platformArch: string;
    releaseBaseCandidatesForComponents: string[];
    requestedComponentIds: Set<string> | null;
    requiredReleasePaths: string[];
    forceRefresh?: boolean;
    remoteAssetNetwork?: RemoteAssetNetworkPort;
  },
  manifest: RemoteAssetManifest,
  loggers: RemoteAssetCacheLoggers,
): Promise<string> {
  const selectedComponents = selectManifestComponents(manifest, options.requestedComponentIds);
  const releaseDir = join(
    options.remoteCacheDir,
    "releases",
    options.version,
    options.platformArch,
    ...resolveContentAddressedReleaseSegments(selectedComponents, options.requestedComponentIds),
  );
  if (
    !options.forceRefresh &&
    (await isReadyReleaseDirForRequestedPaths(
      releaseDir,
      options.platformArch,
      options.requiredReleasePaths,
    ))
  ) {
    return releaseDir;
  }

  // The previous assembly releaseDir will align all components according to the manifest, even if subsequent remote version checks will be skipped.
  // Only the components clearly required for this deployment are implemented here to avoid additional downloading of the latest toolkit when the main server is upgraded.
  const componentCacheEntries: Array<{
    component: RemoteAssetManifestComponent;
    componentDir: string;
  }> = [];
  for (const component of selectedComponents) {
    const componentDir = await ensureRemoteComponentDirFromCdn(
      options,
      component,
      resolveRequiredComponentPaths(component, options.requiredReleasePaths),
      loggers,
      Boolean(options.forceRefresh),
    );
    componentCacheEntries.push({ component, componentDir });
  }

  await runWithReleaseMaterializeLock(releaseDir, async () => {
    await mkdir(releaseDir, { recursive: true });
    for (const { component, componentDir } of componentCacheEntries) {
      await materializeComponentIntoReleaseDir(
        component,
        componentDir,
        releaseDir,
        options.remoteCacheDir,
        options.platformArch,
      );
    }
    await writeFile(
      join(releaseDir, `${MANIFEST_FILE_NAME_PREFIX}${options.platformArch}.json`),
      `${JSON.stringify(manifest)}\n`,
      "utf8",
    );

    if (options.requestedComponentIds) {
      return;
    }

    if (!(await isValidReleaseDir(releaseDir, options.platformArch))) {
      throw new Error("[remote-assets] assembled release directory is invalid");
    }

    await writeReadyMarker(releaseDir, REMOTE_ASSET_READY_MARKER);
  });
  return releaseDir;
}

async function runWithReleaseMaterializeLock(
  releaseDir: string,
  task: () => Promise<void>,
): Promise<void> {
  const lockKey = resolve(releaseDir);
  const previousTask = remoteAssetReleaseMaterializeLocks.get(lockKey);

  const currentTask = (async () => {
    if (previousTask) {
      await previousTask.catch(() => {
        // A previous write failure cannot block subsequent retries; the current task will rematerialize its own components.
      });
    }
    await task();
  })();

  remoteAssetReleaseMaterializeLocks.set(lockKey, currentTask);
  try {
    await currentTask;
  } finally {
    if (remoteAssetReleaseMaterializeLocks.get(lockKey) === currentTask) {
      remoteAssetReleaseMaterializeLocks.delete(lockKey);
    }
  }
}
function normalizeRequestedComponentIds(componentIds: string[] | undefined): Set<string> | null {
  if (!componentIds) {
    return null;
  }

  const normalizedIds = componentIds.map((componentId) => componentId.trim()).filter(Boolean);
  if (normalizedIds.length === 0) {
    return null;
  }

  for (const componentId of normalizedIds) {
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(componentId)) {
      throw new Error(`[remote-assets] component id is invalid: ${componentId}`);
    }
  }

  return new Set(normalizedIds);
}

function normalizeRequiredReleasePaths(requiredReleasePaths: string[] | undefined): string[] {
  if (!requiredReleasePaths) {
    return [];
  }

  return Array.from(
    new Set(
      requiredReleasePaths
        .map((relativePath) =>
          normalizeRemoteAssetRelativePath(relativePath, "requiredReleasePath"),
        )
        .filter(Boolean),
    ),
  );
}

export function selectRemoteAssetManifestComponents(
  manifest: RemoteAssetManifest,
  componentIds?: string[],
): RemoteAssetManifestComponent[] {
  return selectManifestComponents(manifest, normalizeRequestedComponentIds(componentIds));
}

function selectManifestComponents(
  manifest: RemoteAssetManifest,
  requestedComponentIds: Set<string> | null,
): RemoteAssetManifestComponent[] {
  if (!requestedComponentIds) {
    return manifest.components;
  }

  const selectedComponents = manifest.components.filter((component) =>
    requestedComponentIds.has(component.id),
  );
  const foundIds = new Set(selectedComponents.map((component) => component.id));
  const missingIds = Array.from(requestedComponentIds).filter(
    (componentId) => !foundIds.has(componentId),
  );
  if (missingIds.length > 0) {
    throw new Error(
      `[remote-assets] manifest is missing requested components: ${missingIds.join(", ")}`,
    );
  }

  return selectedComponents;
}

async function materializeComponentIntoReleaseDir(
  component: RemoteAssetManifestComponent,
  componentDir: string,
  releaseDir: string,
  remoteCacheDir: string,
  platformArch: string,
): Promise<void> {
  const stagingBaseDir = join(remoteCacheDir, "staging");
  await mkdir(stagingBaseDir, { recursive: true });
  const stagingDir = join(
    stagingBaseDir,
    `remote-release-component-${component.id}-${platformArch}-${process.pid}-${randomUUID()}`,
  );
  const componentStagingDir = join(stagingDir, "component");
  await mkdir(componentStagingDir, { recursive: true });

  try {
    await materializeDirectoryContents(componentDir, componentStagingDir);
    await assertExtractedArchiveNotEmpty(
      componentStagingDir,
      `[remote-assets] release component is empty for ${component.id}@${component.version}`,
    );
    const mountDir = resolvePathWithinBase(
      releaseDir,
      component.mount,
      `component ${component.id} mount`,
    );
    await commitStagingDirectoryAtomically(componentStagingDir, mountDir);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

async function ensureRemoteComponentDirFromCdn(
  options: {
    remoteCacheDir: string;
    version: string;
    platformArch: string;
    releaseBaseCandidatesForComponents: string[];
    remoteAssetNetwork?: RemoteAssetNetworkPort;
  },
  component: RemoteAssetManifestComponent,
  requiredRelativePaths: readonly string[],
  loggers: RemoteAssetCacheLoggers,
  forceRefresh = false,
): Promise<string> {
  const componentDir = resolveComponentCacheDir(
    options.remoteCacheDir,
    component,
    options.platformArch,
  );
  if (
    !forceRefresh &&
    (await isReadyComponentDirForRequiredPaths(componentDir, requiredRelativePaths))
  ) {
    return componentDir;
  }

  // The component lock key did not include remoteCacheDir before, and different cache directories will be linked together by the same component download lock.
  // Here, the absolute path of componentDir is directly used as the key to ensure one-to-one correspondence between the isolation semantics and the placement directory.
  const lockKey = resolve(componentDir);
  while (true) {
    const lockedTask = remoteAssetComponentLocks.get(lockKey);
    if (!lockedTask) {
      break;
    }
    const lockedComponentDir = await lockedTask;
    const missingPaths = await findMissingReadyComponentPaths(
      lockedComponentDir,
      requiredRelativePaths,
    );
    if (missingPaths?.length === 0) {
      return lockedComponentDir;
    }
    // Different deployment calls will share the same component cache lock. After waiting for download,
    // It is still necessary to recheck using the current caller's critical path to avoid returning incomplete cache that only satisfies the old call.
    loggers.logWarn(
      `[remote-assets] locked component cache still incomplete: component=${component.id} missing=${(missingPaths ?? []).join(",")}; redownloading`,
    );
  }

  const task = ensureRemoteComponentDirFromCdnInternal(
    options,
    component,
    requiredRelativePaths,
    loggers,
    forceRefresh,
  ).finally(() => {
    remoteAssetComponentLocks.delete(lockKey);
  });
  remoteAssetComponentLocks.set(lockKey, task);
  return task;
}

async function ensureRemoteComponentDirFromCdnInternal(
  options: {
    remoteCacheDir: string;
    version: string;
    platformArch: string;
    releaseBaseCandidatesForComponents: string[];
    remoteAssetNetwork?: RemoteAssetNetworkPort;
  },
  component: RemoteAssetManifestComponent,
  requiredRelativePaths: readonly string[],
  loggers: RemoteAssetCacheLoggers,
  forceRefresh = false,
): Promise<string> {
  const componentDir = resolveComponentCacheDir(
    options.remoteCacheDir,
    component,
    options.platformArch,
  );
  if (forceRefresh) {
    // App version change represents a new resource release boundary; even if the GLM SHA cache hits,
    // It must also be re-downloaded, verified and replaced atomically to avoid local upload and redeployment of the old cache to the remote end.
    loggers.logWarn(
      `[remote-assets] forced component refresh: component=${component.id} path=${componentDir}`,
    );
  }
  const initialMissingPaths = await findMissingReadyComponentPaths(
    componentDir,
    requiredRelativePaths,
  );
  if (!forceRefresh && initialMissingPaths?.length === 0) {
    return componentDir;
  }
  if (!forceRefresh && initialMissingPaths) {
    // The old version only uses .ready to determine that the component cache is available. The user has previously deployed only
    // After the glm cache of zcode.cjs is added, the incomplete cache will always be reused if packages are re-transmitted.
    // Here, the critical path declared by the caller is verified. If it is missing, the old cache is cleared and the complete component is downloaded from the CDN again.
    loggers.logWarn(
      `[remote-assets] local component cache incomplete: component=${component.id} missing=${initialMissingPaths.join(",")}; redownloading`,
    );
    await rm(componentDir, { recursive: true, force: true });
  }

  if (
    !forceRefresh &&
    !usesRemoteAssetContentAddressedCacheIdentity(component.id) &&
    (await tryMigrateComponentDirFromHashVersionComponentCache(
      options,
      component,
      componentDir,
      loggers,
    ))
  ) {
    const migratedMissingPaths = await findMissingReadyComponentPaths(
      componentDir,
      requiredRelativePaths,
    );
    if (migratedMissingPaths?.length === 0) {
      return componentDir;
    }
    loggers.logWarn(
      `[remote-assets] migrated local component cache incomplete: component=${component.id} missing=${(migratedMissingPaths ?? []).join(",")}; redownloading`,
    );
    await rm(componentDir, { recursive: true, force: true });
  }

  if (
    !forceRefresh &&
    !usesRemoteAssetContentAddressedCacheIdentity(component.id) &&
    (await tryMigrateComponentDirFromLegacyReleaseCache(options, component, componentDir, loggers))
  ) {
    const migratedMissingPaths = await findMissingReadyComponentPaths(
      componentDir,
      requiredRelativePaths,
    );
    if (migratedMissingPaths?.length === 0) {
      return componentDir;
    }
    loggers.logWarn(
      `[remote-assets] migrated local component cache incomplete: component=${component.id} missing=${(migratedMissingPaths ?? []).join(",")}; redownloading`,
    );
    await rm(componentDir, { recursive: true, force: true });
  }

  const artifactUrlCandidates = buildComponentArtifactUrlCandidates(
    options.releaseBaseCandidatesForComponents,
    component.artifactPath,
    options.version,
  );

  const stagingBaseDir = join(options.remoteCacheDir, "staging");
  await mkdir(stagingBaseDir, { recursive: true });
  const stagingDir = join(
    stagingBaseDir,
    `remote-component-${component.id}-${options.platformArch}-${component.version}-${process.pid}-${randomUUID()}`,
  );
  const archivePath = join(stagingDir, "component.tar.gz");
  const extractRoot = join(stagingDir, "extract");
  await mkdir(extractRoot, { recursive: true });

  try {
    const { response: artifactResponse, url: artifactUrl } = await fetchFirstAvailableUrl(
      artifactUrlCandidates,
      `${component.id}@${component.version}`,
      resolveRemoteAssetFetch(options.remoteAssetNetwork),
    );
    loggers.log(`[remote-assets] downloading ${artifactUrl}`);
    await writeResponseBodyToFile(artifactResponse, archivePath, loggers);

    const actualChecksum = await computeFileSha256(archivePath);
    if (actualChecksum !== component.sha256) {
      throw new Error(
        `[remote-assets] sha256 mismatch for ${component.id}@${component.version}: expected=${component.sha256}, actual=${actualChecksum}`,
      );
    }

    await extractTarGzArchive(archivePath, extractRoot);
    await assertExtractedArchiveNotEmpty(
      extractRoot,
      `[remote-assets] extracted component archive is empty for ${component.id}@${component.version}`,
    );
    await writeReadyMarker(extractRoot, REMOTE_ASSET_READY_MARKER);
    await commitStagingDirectoryAtomically(extractRoot, componentDir);
    return componentDir;
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

async function tryMigrateComponentDirFromHashVersionComponentCache(
  options: {
    remoteCacheDir: string;
    platformArch: string;
  },
  component: RemoteAssetManifestComponent,
  componentDir: string,
  loggers: RemoteAssetCacheLoggers,
): Promise<boolean> {
  const cacheVersion = resolveRemoteAssetComponentCacheVersion(component.version);

  const componentRootDir = resolveComponentCacheRootDir(
    options.remoteCacheDir,
    component,
    options.platformArch,
  );
  let entries: Dirent[];
  try {
    entries = await readdir(componentRootDir, { withFileTypes: true });
  } catch {
    return false;
  }

  const legacyVersionPrefix = `${cacheVersion}+`;
  const candidates: Array<{ dir: string; version: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(legacyVersionPrefix)) {
      continue;
    }

    const candidateDir = join(componentRootDir, entry.name);
    if (resolve(candidateDir) === resolve(componentDir)) {
      continue;
    }
    if (!(await isReadyComponentDir(candidateDir))) {
      continue;
    }

    const candidateStat = await stat(candidateDir);
    candidates.push({
      dir: candidateDir,
      version: entry.name,
      mtimeMs: candidateStat.mtimeMs,
    });
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const candidate = candidates[0];
  if (!candidate) {
    return false;
  }

  // The old version of the cache component hashes the content into the directory name (such as v0.11.1+abcd).
  // The new version only hits according to the semantic version; even if the old online manifest still has a hash, it must be migrated to the pure version directory first.
  // Avoid repeated downloads of the same semantic version due to different hash suffixes.
  await migrateComponentSourceDir(
    candidate.dir,
    componentDir,
    component,
    `legacy component cache ${candidate.version}`,
    options.platformArch,
    options.remoteCacheDir,
    loggers,
  );
  return true;
}

async function tryMigrateComponentDirFromLegacyReleaseCache(
  options: {
    remoteCacheDir: string;
    version: string;
    platformArch: string;
  },
  component: RemoteAssetManifestComponent,
  componentDir: string,
  loggers: RemoteAssetCacheLoggers,
): Promise<boolean> {
  const expectedContentHashPrefix = extractContentHashPrefixFromComponentVersion(component.version);
  if (!expectedContentHashPrefix) {
    return false;
  }

  const releasesRootDir = join(options.remoteCacheDir, "releases");
  let releaseEntries: Dirent[];
  try {
    releaseEntries = await readdir(releasesRootDir, { withFileTypes: true });
  } catch {
    return false;
  }

  const legacyReleaseVersions = releaseEntries
    .filter((entry) => entry.isDirectory() && entry.name !== options.version)
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));

  for (const legacyVersion of legacyReleaseVersions) {
    const legacyReleaseDir = join(releasesRootDir, legacyVersion, options.platformArch);
    if (!(await isReadyReleaseDir(legacyReleaseDir, options.platformArch))) {
      continue;
    }

    const legacyComponentSourceDir = resolvePathWithinBase(
      legacyReleaseDir,
      component.mount,
      `legacy component ${component.id} mount`,
    );
    if (!(await isDirectoryPath(legacyComponentSourceDir))) {
      continue;
    }

    let legacyContentHash: string;
    try {
      legacyContentHash = await computePathContentSha256(legacyComponentSourceDir);
    } catch (error) {
      loggers.logWarn(
        `[remote-assets] skip legacy component migration for ${component.id}@${component.version} from ${legacyVersion}: ${String(error)}`,
      );
      continue;
    }
    if (!legacyContentHash.startsWith(expectedContentHashPrefix)) {
      continue;
    }

    await migrateComponentSourceDir(
      legacyComponentSourceDir,
      componentDir,
      component,
      `legacy release ${legacyVersion}`,
      options.platformArch,
      options.remoteCacheDir,
      loggers,
    );
    return true;
  }

  return false;
}

async function migrateComponentSourceDir(
  sourceDir: string,
  componentDir: string,
  component: RemoteAssetManifestComponent,
  sourceLabel: string,
  platformArch: string,
  remoteCacheDir: string,
  loggers: RemoteAssetCacheLoggers,
): Promise<void> {
  const stagingBaseDir = join(remoteCacheDir, "staging");
  await mkdir(stagingBaseDir, { recursive: true });
  const stagingDir = join(
    stagingBaseDir,
    `remote-component-migrate-${component.id}-${platformArch}-${component.version}-${process.pid}-${randomUUID()}`,
  );
  const componentStagingDir = join(stagingDir, "component");
  await mkdir(componentStagingDir, { recursive: true });

  try {
    // When migrating, still use staging + ready atomic commit to avoid the semi-finished product directory being misjudged as available cache by subsequent connections.
    await materializeDirectoryContents(sourceDir, componentStagingDir);
    await assertExtractedArchiveNotEmpty(
      componentStagingDir,
      `[remote-assets] migrated component source is empty for ${component.id}@${component.version}`,
    );
    await writeReadyMarker(componentStagingDir, REMOTE_ASSET_READY_MARKER);
    await commitStagingDirectoryAtomically(componentStagingDir, componentDir);
    loggers.log(
      `[remote-assets] migrated ${component.id}@${component.version} from ${sourceLabel}`,
    );
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

export function buildRemoteAssetManifestFileCandidates(platformArch: string): string[] {
  return buildRemoteManifestFileCandidates(platformArch);
}

function buildRemoteManifestFileCandidates(platformArch: string): string[] {
  return [`${MANIFEST_FILE_NAME_PREFIX}${platformArch}.json`];
}

function resolveReleaseBaseByAssetUrl(
  assetUrl: string,
  releaseBaseCandidates: string[],
): string | null {
  const matchedReleaseBases = releaseBaseCandidates
    .map((releaseBase) => releaseBase.replace(/\/+$/, ""))
    .filter((releaseBase) => releaseBase.length > 0 && assetUrl.startsWith(`${releaseBase}/`))
    .sort((left, right) => right.length - left.length);
  return matchedReleaseBases[0] ?? null;
}

async function fetchFirstAvailableUrl(
  candidates: string[],
  fileLabel: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<{ response: Response; url: string }> {
  const errors: string[] = [];

  for (const candidate of candidates) {
    try {
      const response = await fetchImpl(candidate);
      if (response.ok) {
        return { response, url: candidate };
      }
      errors.push(`${candidate} -> HTTP ${response.status}`);
    } catch (error) {
      errors.push(`${candidate} -> ${String(error)}`);
    }
  }

  throw new Error(`[remote-assets] failed to fetch ${fileLabel}: ${errors.join("; ")}`);
}

async function fetchFirstAvailableManifestOrNullWhenNotFound(options: {
  candidates: string[];
  fileLabel: string;
  version: string;
  platformArch: string;
  manifestRequestTimeoutMs?: number;
  fetch: typeof globalThis.fetch;
}): Promise<{ manifest: RemoteAssetManifest; url: string } | null> {
  const errors: string[] = [];

  for (const candidate of options.candidates) {
    const signal = createRemoteAssetManifestRequestSignal(options.manifestRequestTimeoutMs);
    let response: Response;
    try {
      response = await options.fetch(candidate, { signal });
    } catch (error) {
      errors.push(`${candidate} -> ${String(error)}`);
      continue;
    }
    if (response.status === 404) {
      continue;
    }
    if (!response.ok) {
      errors.push(`${candidate} -> HTTP ${response.status}`);
      continue;
    }

    try {
      return {
        manifest: await parseRemoteAssetManifestFromResponse(
          response,
          candidate,
          options.version,
          options.platformArch,
        ),
        url: candidate,
      };
    } catch (error) {
      if (!signal.aborted) {
        throw error;
      }
      // fetch has completed after receiving the response headers, but the response body may still be half-open;
      // Body timeout is also a network failure of the candidate CDN. You should continue to try the next candidate instead of waiting forever.
      errors.push(`${candidate} -> ${String(error)}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`[remote-assets] failed to fetch ${options.fileLabel}: ${errors.join("; ")}`);
  }
  return null;
}

export async function parseRemoteAssetManifestFromResponse(
  response: Response,
  sourceUrl: string,
  expectedAppVersion: string,
  expectedPlatformArch: string,
): Promise<RemoteAssetManifest> {
  const content = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`[remote-assets] invalid manifest json from ${sourceUrl}: ${String(error)}`);
  }
  if (!isObjectRecord(parsed)) {
    throw new Error(`[remote-assets] invalid manifest payload from ${sourceUrl}: expect object`);
  }

  const schemaVersion = readRequiredNumber(parsed, "schemaVersion", "manifest");
  if (!Number.isInteger(schemaVersion) || schemaVersion !== 1) {
    throw new Error(
      `[remote-assets] unsupported manifest schemaVersion=${schemaVersion} from ${sourceUrl}`,
    );
  }

  const appVersion = readRequiredString(parsed, "appVersion", "manifest");
  if (appVersion !== expectedAppVersion) {
    throw new Error(
      `[remote-assets] manifest appVersion mismatch from ${sourceUrl}: expected=${expectedAppVersion}, actual=${appVersion}`,
    );
  }

  const platformArch = readRequiredString(parsed, "platformArch", "manifest");
  if (platformArch !== expectedPlatformArch) {
    throw new Error(
      `[remote-assets] manifest platformArch mismatch from ${sourceUrl}: expected=${expectedPlatformArch}, actual=${platformArch}`,
    );
  }

  const rawComponents = parsed.components;
  if (!Array.isArray(rawComponents)) {
    throw new Error(`[remote-assets] manifest.components must be array from ${sourceUrl}`);
  }
  if (rawComponents.length === 0) {
    throw new Error(`[remote-assets] manifest.components is empty from ${sourceUrl}`);
  }

  const components: RemoteAssetManifestComponent[] = [];
  const seenIds = new Set<string>();
  for (const [index, rawComponent] of rawComponents.entries()) {
    const context = `manifest.components[${index}]`;
    if (!isObjectRecord(rawComponent)) {
      throw new Error(`[remote-assets] ${context} must be object`);
    }

    const id = readRequiredString(rawComponent, "id", context);
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(id)) {
      throw new Error(`[remote-assets] ${context}.id is invalid: ${id}`);
    }
    if (seenIds.has(id)) {
      throw new Error(`[remote-assets] duplicate component id in manifest: ${id}`);
    }
    seenIds.add(id);

    const mountRule = REMOTE_COMPONENT_MOUNT_RULES[id];
    if (!mountRule) {
      // Old release manifests may still contain retired third-party agent components.
      // The current client only knows ZCode Agent and the basic runtime. Unknown components should be skipped and the download of current components cannot be blocked.
      continue;
    }

    const version = readRequiredString(rawComponent, "version", context);
    assertSafePathSegment(version, `${context}.version`);

    const sha256 = readRequiredString(rawComponent, "sha256", context).toLowerCase();
    if (!/^[a-f0-9]{64}$/u.test(sha256)) {
      throw new Error(`[remote-assets] ${context}.sha256 is invalid`);
    }

    const artifactPath = normalizeRemoteAssetRelativePath(
      readRequiredString(rawComponent, "artifactPath", context),
      `${context}.artifactPath`,
    );
    const mount = normalizeRemoteAssetRelativePath(
      readRequiredString(rawComponent, "mount", context),
      `${context}.mount`,
    );
    const expectedMount = normalizeRemoteAssetRelativePath(
      mountRule.resolveExpectedMount(expectedPlatformArch),
      `expected mount for ${id}`,
    );
    if (mount !== expectedMount) {
      throw new Error(
        `[remote-assets] ${context}.mount mismatch for ${id}: expected=${expectedMount}, actual=${mount}`,
      );
    }

    components.push({
      id,
      version,
      sha256,
      artifactPath,
      mount,
    });
  }

  return {
    schemaVersion,
    appVersion,
    platformArch,
    components,
  };
}

function resolveComponentCacheDir(
  remoteCacheDir: string,
  component: RemoteAssetManifestComponent,
  platformArch: string,
): string {
  return join(
    resolveComponentCacheRootDir(remoteCacheDir, component, platformArch),
    usesRemoteAssetContentAddressedCacheIdentity(component.id)
      ? component.sha256
      : resolveRemoteAssetComponentCacheVersion(component.version),
  );
}

export function usesRemoteAssetContentAddressedCacheIdentity(componentId: string): boolean {
  return componentId in CONTENT_ADDRESSED_COMPONENT_RELEASE_DIRS;
}

function resolveContentAddressedReleaseSegments(
  components: readonly RemoteAssetManifestComponent[],
  requestedComponentIds: ReadonlySet<string> | null,
): string[] {
  const segments: string[] = [];
  for (const componentId of Object.keys(CONTENT_ADDRESSED_COMPONENT_RELEASE_DIRS)) {
    // Compatible with all historical releases: only the original GLM content directory will be used when no components are specified; server
    // Installations always explicitly request the server-bundle, so standalone SHA releases are still entered.
    if (
      requestedComponentIds === null
        ? componentId !== "glm"
        : !requestedComponentIds.has(componentId)
    ) {
      continue;
    }
    const component = components.find((item) => item.id === componentId);
    const releaseDirName = CONTENT_ADDRESSED_COMPONENT_RELEASE_DIRS[componentId];
    if (component && releaseDirName) {
      segments.push(releaseDirName, component.sha256);
    }
  }
  return segments;
}

export function resolveRemoteAssetComponentCacheVersion(version: string): string {
  const contentHashPrefix = extractContentHashPrefixFromComponentVersion(version);
  if (!contentHashPrefix) {
    return version;
  }

  // component.version in the published manifest is still vX+hash.
  // The cache key only looks at the semantic version, so the hash is stripped off at the disk directory level; artifactPath/sha256 still verifies the downloaded content according to the manifest.
  return version.slice(0, -contentHashPrefix.length - 1);
}

function resolveComponentCacheRootDir(
  remoteCacheDir: string,
  component: RemoteAssetManifestComponent,
  platformArch: string,
): string {
  const mountRule = REMOTE_COMPONENT_MOUNT_RULES[component.id];
  if (!mountRule) {
    throw new Error(`[remote-assets] component id is not in local whitelist: ${component.id}`);
  }
  return mountRule.platformScoped
    ? join(remoteCacheDir, "components", component.id, platformArch)
    : join(remoteCacheDir, "components", component.id);
}

function resolveRequiredComponentPaths(
  component: RemoteAssetManifestComponent,
  requiredReleasePaths: readonly string[],
): string[] {
  if (requiredReleasePaths.length === 0) {
    return [];
  }

  const mount = component.mount.replace(/\/+$/u, "");
  const requiredComponentPaths: string[] = [];
  for (const requiredReleasePath of requiredReleasePaths) {
    if (requiredReleasePath === mount) {
      continue;
    }
    if (requiredReleasePath.startsWith(`${mount}/`)) {
      requiredComponentPaths.push(requiredReleasePath.slice(mount.length + 1));
    }
  }
  return requiredComponentPaths;
}

async function materializeDirectoryContents(sourceDir: string, targetDir: string): Promise<void> {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (READY_MARKER_CANDIDATES.includes(entry.name)) {
      continue;
    }

    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);

    if (entry.isSymbolicLink()) {
      throw new Error(`[remote-assets] symlink is not allowed in component cache: ${sourcePath}`);
    }
    if (entry.isDirectory()) {
      await mkdir(targetPath, { recursive: true });
      await materializeDirectoryContents(sourcePath, targetPath);
      continue;
    }
    if (entry.isFile()) {
      await mkdir(dirname(targetPath), { recursive: true });
      await linkOrCopyFile(sourcePath, targetPath);
      continue;
    }

    throw new Error(`[remote-assets] unsupported component entry type: ${sourcePath}`);
  }
}

async function linkOrCopyFile(sourcePath: string, targetPath: string): Promise<void> {
  try {
    await link(sourcePath, targetPath);
    return;
  } catch (error) {
    if (!shouldFallbackToCopy(error)) {
      throw error;
    }
  }
  await copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL);
}

function shouldFallbackToCopy(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EXDEV" || code === "EPERM" || code === "EACCES" || code === "EMLINK";
}

function resolvePathWithinBase(baseDir: string, relativePath: string, label: string): string {
  const normalizedRelativePath = normalizeRemoteAssetRelativePath(relativePath, label);
  const targetPath = resolve(baseDir, ...normalizedRelativePath.split("/"));
  const normalizedBaseDir = resolve(baseDir);
  if (targetPath !== normalizedBaseDir && !targetPath.startsWith(`${normalizedBaseDir}${sep}`)) {
    throw new Error(`[remote-assets] ${label} escapes base dir: ${relativePath}`);
  }
  return targetPath;
}

async function commitStagingDirectoryAtomically(
  stagingDir: string,
  targetDir: string,
): Promise<void> {
  await mkdir(dirname(targetDir), { recursive: true });

  const targetExists = await pathExists(targetDir);
  const backupDir = targetExists ? `${targetDir}.backup-${process.pid}-${randomUUID()}` : null;

  if (backupDir) {
    await renameRemoteAssetDirectoryWithRetry(targetDir, backupDir);
  }

  try {
    await renameRemoteAssetDirectoryWithRetry(stagingDir, targetDir);
  } catch (error) {
    if (backupDir) {
      try {
        await renameRemoteAssetDirectoryWithRetry(backupDir, targetDir);
      } catch (restoreError) {
        throw new Error(
          `[remote-assets] failed to commit staged directory and failed to restore backup: ` +
            `commit=${String(error)}, restore=${String(restoreError)}`,
        );
      }
    }
    throw error;
  }

  if (backupDir) {
    await removeRemoteAssetDirectoryBestEffort(backupDir);
  }
}

async function removeRemoteAssetDirectoryBestEffort(path: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const retryDelayMs = REMOTE_ASSET_DIRECTORY_COMMIT_RETRY_DELAYS_MS[attempt];
      if (retryDelayMs === undefined || !isRetryableRemoteAssetDirectoryCommitError(error)) {
        return;
      }
      await sleep(retryDelayMs);
    }
  }
}

async function renameRemoteAssetDirectoryWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const retryDelayMs = REMOTE_ASSET_DIRECTORY_COMMIT_RETRY_DELAYS_MS[attempt];
      if (retryDelayMs === undefined || !isRetryableRemoteAssetDirectoryCommitError(error)) {
        throw error;
      }

      // AppData remote-assets-cache directory rename on Windows may be blocked by Defender, Indexer
      // Or another host process that just exited is temporarily occupied, manifesting as EPERM/EBUSY/EACCES/ENOTEMPTY.
      // Privilege escalation cannot release these file handles, so here we do a limited backoff retry for directory submission to avoid failure to connect to WSL after the cache has been downloaded.
      await sleep(retryDelayMs);
    }
  }
}

function isRetryableRemoteAssetDirectoryCommitError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES" || code === "ENOTEMPTY";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isReadyReleaseDirForRequestedPaths(
  releaseDir: string,
  platformArch: string,
  requiredReleasePaths: readonly string[],
): Promise<boolean> {
  if (!(await isReadyReleaseDir(releaseDir, platformArch))) {
    return false;
  }

  return (await findMissingLocalRelativePaths(releaseDir, requiredReleasePaths)).length === 0;
}

async function isReadyComponentDirForRequiredPaths(
  componentDir: string,
  requiredRelativePaths: readonly string[],
): Promise<boolean> {
  const missingPaths = await findMissingReadyComponentPaths(componentDir, requiredRelativePaths);
  return missingPaths?.length === 0;
}

async function findMissingReadyComponentPaths(
  componentDir: string,
  requiredRelativePaths: readonly string[],
): Promise<string[] | null> {
  if (!(await isReadyComponentDir(componentDir))) {
    return null;
  }

  return findMissingLocalRelativePaths(componentDir, requiredRelativePaths);
}

async function findMissingLocalRelativePaths(
  baseDir: string,
  requiredRelativePaths: readonly string[],
): Promise<string[]> {
  const missingPaths: string[] = [];
  for (const requiredRelativePath of requiredRelativePaths) {
    const absolutePath = resolvePathWithinBase(
      baseDir,
      requiredRelativePath,
      "required cache path",
    );
    if (!(await pathExists(absolutePath))) {
      missingPaths.push(absolutePath);
    }
  }
  return missingPaths;
}

async function writeResponseBodyToFile(
  response: Response,
  targetPath: string,
  loggers: RemoteAssetCacheLoggers,
): Promise<void> {
  if (!response.body) {
    throw new Error("response body is empty");
  }

  await mkdir(dirname(targetPath), { recursive: true });
  const output = createWriteStream(targetPath, { flags: "w" });
  const reportProgress = createRemoteAssetProgressReporter(
    parseContentLength(response.headers.get("content-length")),
    loggers,
  );
  let transferredBytes = 0;

  const byteMeter = new Transform({
    transform(chunk, _encoding, callback) {
      transferredBytes += chunk.byteLength;
      reportProgress(transferredBytes, false);
      callback(null, chunk);
    },
  });

  await pipeline(Readable.fromWeb(response.body as globalThis.ReadableStream), byteMeter, output);
  reportProgress(transferredBytes, true);
}

function parseContentLength(contentLengthHeader: string | null): number | null {
  if (!contentLengthHeader) {
    return null;
  }

  const parsed = Number.parseInt(contentLengthHeader, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function createRemoteAssetProgressReporter(
  totalBytes: number | null,
  loggers: RemoteAssetCacheLoggers | undefined,
): (transferredBytes: number, force: boolean) => void {
  const startedAt = Date.now();
  let lastLoggedAt = 0;
  let lastLoggedPercent = 0;
  let lastLoggedTransferredBytes = -1;

  return (transferredBytes: number, force: boolean) => {
    if (!loggers) {
      return;
    }

    const now = Date.now();
    const elapsedSeconds = Math.max((now - startedAt) / 1_000, 0.001);
    const speedMBPerSecond = bytesToMB(transferredBytes) / elapsedSeconds;
    const transferredMB = bytesToMB(transferredBytes);
    const totalMB = totalBytes ? bytesToMB(totalBytes) : null;
    const percent = totalBytes ? Math.min((transferredBytes / totalBytes) * 100, 100) : null;

    const byInterval = now - lastLoggedAt >= REMOTE_ASSET_PROGRESS_INTERVAL_MS;
    const byPercent =
      percent != null && percent - lastLoggedPercent >= REMOTE_ASSET_PROGRESS_PERCENT_STEP;
    const reachedEnd = percent != null && percent >= 100;

    if (!force && !byInterval && !byPercent && !reachedEnd) {
      return;
    }
    if (
      force &&
      transferredBytes === lastLoggedTransferredBytes &&
      (percent == null || percent <= lastLoggedPercent)
    ) {
      return;
    }

    // Previously, only "downloading URL" was printed during the production download phase, and slow network users could not determine whether it was stuck.
    // This is changed to output the progress snapshot after throttling (percent/MB/speed), so that the SSH connection log can observe the download progress.
    if (totalMB != null && percent != null) {
      loggers.log(
        `[remote-assets] download progress: ${percent.toFixed(1)}% (${transferredMB.toFixed(1)}/${totalMB.toFixed(1)} MB, ${speedMBPerSecond.toFixed(2)} MB/s)`,
      );
    } else {
      loggers.log(
        `[remote-assets] download progress: ${transferredMB.toFixed(1)} MB (total unknown, ${speedMBPerSecond.toFixed(2)} MB/s)`,
      );
    }

    lastLoggedAt = now;
    lastLoggedTransferredBytes = transferredBytes;
    if (percent != null) {
      lastLoggedPercent = percent;
    }
  };
}

function bytesToMB(bytes: number): number {
  return bytes / (1024 * 1024);
}

function extractContentHashPrefixFromComponentVersion(version: string): string | null {
  const plusIndex = version.lastIndexOf("+");
  if (plusIndex < 0 || plusIndex === version.length - 1) {
    return null;
  }

  const suffix = version.slice(plusIndex + 1).toLowerCase();
  return /^[a-f0-9]{12,64}$/u.test(suffix) ? suffix : null;
}

async function isDirectoryPath(path: string): Promise<boolean> {
  try {
    const pathStat = await stat(path);
    return pathStat.isDirectory();
  } catch {
    return false;
  }
}

async function computePathContentSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  const pathStat = await stat(path);

  if (pathStat.isDirectory()) {
    hash.update("root:dir\n");
    await hashDirectoryContent(hash, path);
  } else if (pathStat.isFile()) {
    hash.update("root:file\n");
    await hashFileContent(hash, path, "root-file");
  } else {
    throw new Error(`unsupported path type: ${path}`);
  }

  return hash.digest("hex");
}

async function hashDirectoryContent(
  hash: ReturnType<typeof createHash>,
  rootDir: string,
  relativeDir = "",
): Promise<void> {
  const entries = (await readdir(rootDir, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  for (const entry of entries) {
    const entryPath = join(rootDir, entry.name);
    const entryRelativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      const dirStat = await stat(entryPath);
      hash.update(`dir:${entryRelativePath}:${dirStat.mode & 0o777}\n`);
      await hashDirectoryContent(hash, entryPath, entryRelativePath);
      continue;
    }
    if (entry.isFile()) {
      await hashFileContent(hash, entryPath, entryRelativePath);
      continue;
    }

    throw new Error(`unsupported entry type: ${entryPath}`);
  }
}

async function hashFileContent(
  hash: ReturnType<typeof createHash>,
  filePath: string,
  relativePath: string,
): Promise<void> {
  const fileStat = await stat(filePath);
  hash.update(`file:${relativePath}:${fileStat.mode & 0o777}:${fileStat.size}\n`);
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
}

async function computeFileSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

async function assertExtractedArchiveNotEmpty(
  extractRoot: string,
  errorMessage: string,
): Promise<void> {
  const entries = await readdir(extractRoot, { withFileTypes: true });
  if (entries.length === 0) {
    throw new Error(errorMessage);
  }
}

async function isReadyReleaseDir(releaseDir: string, platformArch: string): Promise<boolean> {
  if (!(await isValidReleaseDir(releaseDir, platformArch))) {
    return false;
  }

  return hasReadyMarker(releaseDir);
}

async function isValidReleaseDir(releaseDir: string, platformArch: string): Promise<boolean> {
  try {
    const dirStat = await stat(releaseDir);
    if (!dirStat.isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }

  if (!(await fileExists(releaseDir, "server", "zcode-server.cjs"))) {
    return false;
  }

  // After the platform-specific archiving is implemented, continuing to hard-code the verification of the Linux directory will misjudge the darwin package as invalid.
  // Here it is changed to verify the node runtime based on the target platformArch to ensure that the cache judgment is consistent with the download strategy.
  if (!(await fileExists(releaseDir, "node", platformArch, "node"))) {
    return false;
  }

  return true;
}

async function isReadyComponentDir(componentDir: string): Promise<boolean> {
  try {
    const dirStat = await stat(componentDir);
    if (!dirStat.isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }

  return hasReadyMarker(componentDir);
}

async function hasReadyMarker(baseDir: string): Promise<boolean> {
  for (const readyMarker of READY_MARKER_CANDIDATES) {
    if (await fileExists(baseDir, readyMarker)) {
      return true;
    }
  }
  return false;
}

async function writeReadyMarker(baseDir: string, markerFileName: string): Promise<void> {
  await writeFile(join(baseDir, markerFileName), `${Date.now()}\n`, "utf8");
}

export async function readCachedRemoteAssetMarker(cacheDir: string): Promise<string | null> {
  for (const readyMarker of READY_MARKER_CANDIDATES) {
    const markerPath = join(cacheDir, readyMarker);
    try {
      return await readFile(markerPath, "utf8");
    } catch {
      // continue
    }
  }
  return null;
}

export function resolveFallbackRemoteAssetCacheDir(): string {
  return join(tmpdir(), "zcode-remote-assets-cache");
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequiredString(value: Record<string, unknown>, key: string, context: string): string {
  const fieldValue = value[key];
  if (typeof fieldValue !== "string") {
    throw new Error(`[remote-assets] ${context}.${key} must be string`);
  }
  const trimmed = fieldValue.trim();
  if (!trimmed) {
    throw new Error(`[remote-assets] ${context}.${key} is empty`);
  }
  return trimmed;
}

function readRequiredNumber(value: Record<string, unknown>, key: string, context: string): number {
  const fieldValue = value[key];
  if (typeof fieldValue !== "number" || !Number.isFinite(fieldValue)) {
    throw new Error(`[remote-assets] ${context}.${key} must be finite number`);
  }
  return fieldValue;
}

function assertSafePathSegment(value: string, label: string): void {
  if (!value.trim()) {
    throw new Error(`[remote-assets] ${label} is empty`);
  }
  if (value.includes("/") || value.includes("\\")) {
    throw new Error(`[remote-assets] ${label} must be a single path segment: ${value}`);
  }
  if (value === "." || value === "..") {
    throw new Error(`[remote-assets] ${label} is invalid: ${value}`);
  }
}
