import { ZCODE_VERSION } from "@zcode/shared";
import type { IRemoteBackend, RemoteEnvironment } from "@zcode/server/remote/backend.js";
import {
  REMOTE_BASE,
  type DeployLoggers,
  type RemoteAssetDeployOptions,
} from "@zcode/server/remote/deployShared.js";
import {
  readRemoteAssetComponentMeta,
  writeRemoteAssetComponentMeta,
} from "@zcode/server/remote/remoteAssetLiveIdentity.js";
import {
  fetchRemoteAssetManifestFromCdn,
  resolveRemoteAssetComponentCacheVersion,
  selectRemoteAssetManifestComponents,
  type RemoteAssetManifest,
} from "@zcode/server/remote/remoteAssetCache.js";
import {
  LocalUploadAssetInstaller,
  type RemoteAssetInstaller,
} from "@zcode/server/remote/remoteAssetInstaller.js";
import type { RemoteAssetNetworkPort } from "@zcode/server/remote/remoteAssetNetwork.js";

// The Rust PTY addon is a single self-contained zcode_pty.node (no separate spawn-helper binary),
// so the remote terminal component ships exactly one file and needs no exec-bit fixup.
const REMOTE_ZCODE_PTY_PATH = `${REMOTE_BASE}/zcode-pty/zcode_pty.node`;

export interface RemoteAssetVersionResolverOptions {
  mockCdnDir?: string;
  remoteCdnBaseUrl?: string;
  remoteCdnBaseUrls?: string[];
  remoteCacheDir?: string;
  manifestRequestTimeoutMs?: number;
  remoteAssetNetwork?: RemoteAssetNetworkPort;
}

interface DeployZcodePtyOptions extends RemoteAssetDeployOptions {
  platformArch: string;
  force?: boolean;
  onlyIfMissing: boolean;
  installer: RemoteAssetInstaller;
  expectedVersion?: string | null;
}

interface DeployNodeRuntimeOptions extends RemoteAssetDeployOptions {
  platformArch: string;
  force?: boolean;
  installer: RemoteAssetInstaller;
  expectedVersion?: string | null;
}

type DeployDecision = { shouldDeploy: false } | { shouldDeploy: true; reason: string };

export function createRemoteComponentVersionResolver(
  options: RemoteAssetVersionResolverOptions,
  env: RemoteEnvironment,
  loggers: DeployLoggers,
): (componentId: string) => Promise<string | null> {
  let componentManifestPromise: Promise<RemoteAssetManifest | null> | null = null;
  const getComponentManifest = (): Promise<RemoteAssetManifest | null> => {
    componentManifestPromise ??= resolveComponentManifest(options, env, loggers);
    return componentManifestPromise;
  };

  return async (componentId) => {
    const manifest = await getComponentManifest();
    if (!manifest) {
      return null;
    }
    const componentVersion = selectRemoteAssetManifestComponents(manifest, [componentId])[0]
      ?.version;
    return componentVersion ? resolveRemoteAssetComponentCacheVersion(componentVersion) : null;
  };
}

export async function deployNodeRuntime(
  backend: IRemoteBackend,
  options: DeployNodeRuntimeOptions,
  loggers: DeployLoggers,
): Promise<void> {
  const { platformArch, installer } = options;
  const remotePath = `${REMOTE_BASE}/node`;
  const expectedVersion = normalizeDeployExpectedVersion(options.expectedVersion);
  const decision = await shouldDeployVersionedComponent(backend, {
    componentId: "node-runtime",
    platformArch,
    remotePath,
    expectedVersion,
    force: options.force,
    fallbackDeployWhenVersionUnknown: true,
  });
  if (!decision.shouldDeploy) {
    loggers.log("node runtime already matches, skip");
    return;
  }

  logDeployRequired({
    loggers,
    installer,
    componentId: "node-runtime",
    reason: decision.reason,
  });
  await installer.installFile({
    componentId: "node-runtime",
    sourceRelativePath: `node/${platformArch}/node`,
    remotePath,
    executable: true,
  });
  await writeRemoteAssetComponentMeta(backend, {
    id: "node-runtime",
    version: expectedVersion ?? "unknown",
    platformArch,
  });
  loggers.log("node install done");
}

function normalizeDeployExpectedVersion(version: string | null | undefined): string | null {
  return version ? resolveRemoteAssetComponentCacheVersion(version) : null;
}

export async function deployZcodePtyAddon(
  backend: IRemoteBackend,
  _env: RemoteEnvironment,
  options: DeployZcodePtyOptions,
  loggers: DeployLoggers,
): Promise<void> {
  const { platformArch, onlyIfMissing, installer } = options;
  const expectedVersion = normalizeDeployExpectedVersion(options.expectedVersion);
  const decision = await shouldDeployVersionedComponent(backend, {
    componentId: "zcode-pty",
    platformArch,
    remotePath: REMOTE_ZCODE_PTY_PATH,
    expectedVersion,
    force: options.force,
    fallbackDeployWhenVersionUnknown: !onlyIfMissing,
  });
  if (!decision.shouldDeploy) {
    loggers.log("zcode-pty addon already exists, skip");
    return;
  }

  const sourceRelativePath = `zcode-pty/${platformArch}/zcode_pty.node`;
  if (
    installer instanceof LocalUploadAssetInstaller &&
    !(await installer.tryResolveLocalPath(["zcode-pty"], sourceRelativePath))
  ) {
    loggers.logWarn(`WARNING: no zcode-pty addon for ${platformArch}. Terminal will not work.`);
    loggers.logWarn(`Run: node scripts/prepare-prebuilds.mjs to prepare mock-cdn release assets.`);
    return;
  }

  logDeployRequired({
    loggers,
    installer,
    componentId: "zcode-pty",
    reason: decision.reason,
  });
  loggers.log("installing zcode-pty addon...");
  // A single self-contained addon: no platform-specific spawn-helper follow-up (Rust has none).
  await installer.installFile({
    componentId: "zcode-pty",
    sourceRelativePath,
    remotePath: REMOTE_ZCODE_PTY_PATH,
  });
  await writeRemoteAssetComponentMeta(backend, {
    id: "zcode-pty",
    version: expectedVersion ?? "unknown",
    platformArch,
  });
  loggers.log("zcode-pty install done");
}

async function shouldDeployVersionedComponent(
  backend: IRemoteBackend,
  options: {
    componentId: string;
    platformArch: string;
    remotePath: string;
    expectedVersion?: string | null;
    force?: boolean;
    fallbackDeployWhenVersionUnknown: boolean;
  },
): Promise<DeployDecision> {
  if (options.force) {
    return { shouldDeploy: true, reason: "force deploy requested" };
  }

  if (!(await backend.exists(options.remotePath))) {
    return {
      shouldDeploy: true,
      reason: `remote file missing path=${options.remotePath}`,
    };
  }

  if (!options.expectedVersion) {
    return options.fallbackDeployWhenVersionUnknown
      ? {
          shouldDeploy: true,
          reason: "component version unavailable, using legacy full deploy",
        }
      : { shouldDeploy: false };
  }

  const remoteMeta = await readRemoteAssetComponentMeta(backend, options.componentId);
  if (!remoteMeta) {
    return {
      shouldDeploy: true,
      reason: `remote component meta missing expected=${options.expectedVersion}`,
    };
  }
  if (remoteMeta.id !== options.componentId) {
    return {
      shouldDeploy: true,
      reason: `remote component id mismatch remote=${remoteMeta.id} expected=${options.componentId}`,
    };
  }
  if (remoteMeta.platformArch !== options.platformArch) {
    return {
      shouldDeploy: true,
      reason: `remote platform mismatch remote=${remoteMeta.platformArch} expected=${options.platformArch}`,
    };
  }
  if (
    normalizeDeployExpectedVersion(remoteMeta.version) !==
    normalizeDeployExpectedVersion(options.expectedVersion)
  ) {
    return {
      shouldDeploy: true,
      reason: `remote version mismatch remote=${remoteMeta.version} expected=${options.expectedVersion}`,
    };
  }

  return { shouldDeploy: false };
}

export function logDeployRequired(options: {
  loggers: Pick<DeployLoggers, "logWarn">;
  installer: RemoteAssetInstaller;
  componentId: string;
  reason: string;
}): void {
  const action =
    options.installer.mode === "remote-download" ? "download required" : "upload required";
  options.loggers.logWarn(
    `[remote-assets] ${action}: component=${options.componentId} reason=${options.reason}`,
  );
}

async function resolveComponentManifest(
  options: RemoteAssetVersionResolverOptions,
  env: RemoteEnvironment,
  loggers: DeployLoggers,
): Promise<RemoteAssetManifest | null> {
  if (options.mockCdnDir) {
    return null;
  }

  try {
    return await fetchRemoteAssetManifestFromCdn(
      {
        remoteCdnBaseUrl: options.remoteCdnBaseUrl,
        remoteCdnBaseUrls: options.remoteCdnBaseUrls,
        remoteCacheDir: options.remoteCacheDir,
        version: ZCODE_VERSION,
        platformArch: `${env.platform}-${env.arch}`,
        manifestRequestTimeoutMs: options.manifestRequestTimeoutMs,
        remoteAssetNetwork: options.remoteAssetNetwork,
      },
      loggers,
    );
  } catch (error) {
    loggers.logWarn(`[remote-assets] component manifest request failed: ${String(error)}`);
    // version resolver 与 pinned identity 共享同一 manifest deadline。
    // 网络/响应体失败时不得降级成 null，否则持锁路径会再发起默认 10s 请求。
    throw error;
  }
}
