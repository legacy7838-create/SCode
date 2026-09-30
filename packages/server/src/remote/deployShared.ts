import { join } from "node:path";
import { access } from "node:fs/promises";
import type { StdioStream } from "@zcode/server/remote/backend.js";
import { quotePosixPathArg } from "@zcode/server/remote/posixShell.js";
import type { RemoteAssetNetworkPort } from "@zcode/server/remote/remoteAssetNetwork.js";

export const REMOTE_BASE = "~/.zcode/server";

export interface RemoteAssetDeployOptions {
  /** Cancel the current connection initialization; the shared cache can still be completed independently, but it must not continue to write to the remote staging. */
  signal?: AbortSignal;
  releaseDir?: string | null;
  resolveReleaseDir?: (
    componentIds?: string[],
    options?: { forceRefresh?: boolean },
  ) => Promise<string | null>;
  resolveComponentSha256?: (componentId: string) => Promise<string | null>;
  remoteCdnBaseUrl?: string;
  remoteCdnBaseUrls?: string[];
  remoteCacheDir?: string;
  manifestRequestTimeoutMs?: number;
  remoteAssetNetwork?: RemoteAssetNetworkPort;
}

export interface DeployLoggers {
  log: (...args: unknown[]) => void;
  logWarn: (...args: unknown[]) => void;
}

export async function fileExists(...pathParts: string[]): Promise<boolean> {
  const fullPath = join(...pathParts);
  try {
    await access(fullPath);
    return true;
  } catch {
    return false;
  }
}

export async function resolveFirstExistingPath(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function formatOptionalValue(value?: string): string {
  return value && value.trim().length > 0 ? value : "<empty>";
}

export function formatOptionalValues(values?: string[]): string {
  const normalizedValues = values?.map((value) => value.trim()).filter((value) => value.length > 0);
  return normalizedValues && normalizedValues.length > 0 ? normalizedValues.join(", ") : "<empty>";
}

export function buildRemoteMoveCommand(sourcePath: string, targetPath: string): string {
  // Some remote shells will define mv as an alias/function (such as mv -i).
  // When the deployment is executed through non-interactive SSH exec, overwriting and confirming that no one enters will freeze; command is used here to bypass alias/function.
  // At the same time, add -f to explicitly force overwriting to ensure that temporary file replacement will not wait for interactive confirmation.
  return `command mv -f ${quotePosixPathArg(sourcePath)} ${quotePosixPathArg(targetPath)}`;
}

export function buildRemoteChmodExecutableCommand(filePath: string): string {
  // Like mv, chmod may also be customized by the remote shell; use command to ensure that the actual command is called.
  return `command chmod +x ${quotePosixPathArg(filePath)}`;
}

export function buildRemoteExecutableReplaceCommand(
  sourcePath: string,
  targetPath: string,
): string {
  return `${buildRemoteChmodExecutableCommand(sourcePath)} && ${buildRemoteMoveCommand(sourcePath, targetPath)}`;
}

export function createRemoteAssetPlaceholderError(
  platformArch: string,
  options: RemoteAssetDeployOptions,
  resourceLabel: string,
): Error {
  // Remotely deployed resources require CDN + local caching in production.
  // If only "Local files are missing" is still reported here, it will be mistakenly diagnosed as missing files in the package during troubleshooting;
  // Unify errors to the configuration (CDN base address/cache directory) and cache content to avoid deviation in the positioning direction.
  return new Error(
    `[deploy] ${resourceLabel} missing for ${platformArch}. ` +
      `Development should read from mock-cdn/releases; production should download and cache remote assets from CDN ` +
      `(remoteCdnBaseUrl=${formatOptionalValue(options.remoteCdnBaseUrl)}, remoteCdnBaseUrls=${formatOptionalValues(options.remoteCdnBaseUrls)}, remoteCacheDir=${formatOptionalValue(options.remoteCacheDir)}).`,
  );
}

export function waitForClose(stream: StdioStream): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderrText = "";
    stream.stderr.on("data", (chunk: Buffer | string) => {
      if (stderrText.length >= 2048) {
        return;
      }
      stderrText += chunk.toString();
    });

    stream.onClose((code) => {
      // Previously, we only waited for close without verifying the exit code. Failure of the remote command would be regarded as successful and continued execution.
      // This will cause the deployment link to write failure as "completed" (or even continue to write version), forming a false success state.
      if (code !== 0) {
        const stderrSummary = stderrText.trim();
        reject(
          new Error(
            stderrSummary.length > 0
              ? `[deploy] remote command failed with exit code ${code}: ${stderrSummary}`
              : `[deploy] remote command failed with exit code ${code}`,
          ),
        );
        return;
      }
      resolve();
    });
  });
}
