import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { IRemoteBackend, StdioStream } from "@zcode/server/remote/backend.js";
import { REMOTE_BASE } from "@zcode/server/remote/deployShared.js";
import { quotePosixPathArg, quotePosixShellArg } from "@zcode/server/remote/posixShell.js";

const DEPLOY_LOCK_HEARTBEAT_SECONDS = 30;
const DEPLOY_LOCK_STALE_SECONDS = 600;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 120_000;
const DEFAULT_RELEASE_TIMEOUT_MS = 5_000;
const MAX_LOCK_STDERR_LENGTH = 4_096;

export interface RemoteDeployLockHandle {
  ownerToken: string;
  release(): Promise<void>;
}

export interface AcquireRemoteDeployLockOptions {
  lockDir?: string;
  ownerToken?: string;
  acquireTimeoutMs?: number;
  releaseTimeoutMs?: number;
}

function destroyStreamBestEffort(stream: NodeJS.ReadableStream | NodeJS.WritableStream): void {
  try {
    (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
  } catch {
    // After the release timeout, only the best effort is made to close this lock-holder stream; if the cleanup fails, the timeout diagnosis cannot be overwritten again.
  }
}

function destroyLockStreamBestEffort(stream: StdioStream): void {
  destroyStreamBestEffort(stream.stdin);
  destroyStreamBestEffort(stream.stdout);
  destroyStreamBestEffort(stream.stderr);
}

function buildRemoteDeployLockScript(lockDir: string, ownerToken: string): string {
  const acquiredMarker = `zcode-deploy-lock-acquired:${ownerToken}`;
  const releaseMarker = `zcode-deploy-lock-release:${ownerToken}`;
  return [
    "set -eu",
    `lock_dir=${quotePosixPathArg(lockDir)}`,
    `owner_token=${quotePosixShellArg(ownerToken)}`,
    'owner_file="$lock_dir/owner"',
    'stale_dir="$lock_dir.stale-$owner_token"',
    `mkdir -p ${quotePosixPathArg(posix.dirname(lockDir))}`,
    'while ! mkdir "$lock_dir" 2>/dev/null; do',
    '  lock_mtime=$({ stat -c %Y "$owner_file" || stat -f %m "$owner_file" || stat -c %Y "$lock_dir" || stat -f %m "$lock_dir"; } 2>/dev/null || printf 0)',
    "  lock_now=$(date +%s)",
    `  if [ "$lock_mtime" -gt 0 ] && [ $((lock_now - lock_mtime)) -ge ${DEPLOY_LOCK_STALE_SECONDS} ]; then`,
    '    if command mv "$lock_dir" "$stale_dir" 2>/dev/null; then rm -rf "$stale_dir"; fi',
    "    continue",
    "  fi",
    "  sleep 1",
    "done",
    'printf %s "$owner_token" > "$owner_file"',
    "lock_heartbeat_pid=",
    "cleanup_deploy_lock() {",
    '  if [ -n "${lock_heartbeat_pid:-}" ]; then kill "$lock_heartbeat_pid" >/dev/null 2>&1 || true; wait "$lock_heartbeat_pid" 2>/dev/null || true; fi',
    '  current_owner=$(cat "$owner_file" 2>/dev/null || true)',
    '  if [ "$current_owner" = "$owner_token" ]; then rm -rf "$lock_dir"; fi',
    "}",
    "trap cleanup_deploy_lock EXIT HUP INT TERM",
    `(while [ "$(cat "$owner_file" 2>/dev/null || true)" = "$owner_token" ]; do touch "$owner_file" 2>/dev/null || exit 0; sleep ${DEPLOY_LOCK_HEARTBEAT_SECONDS}; done) &`,
    "lock_heartbeat_pid=$!",
    `printf '%s\n' ${quotePosixShellArg(acquiredMarker)}`,
    "release_marker=",
    "IFS= read -r release_marker || true",
    `if [ "$release_marker" != ${quotePosixShellArg(releaseMarker)} ]; then echo ${quotePosixShellArg("[deploy-lock] invalid release marker")} >&2; exit 1; fi`,
  ].join("\n");
}

function encodePosixOctal(value: string): string {
  return Array.from(
    Buffer.from(value, "utf8"),
    (byte) => `\\${byte.toString(8).padStart(3, "0")}`,
  ).join("");
}

function buildRemoteDeployLockCommand(lockDir: string, ownerToken: string): string {
  const scriptPath = `${lockDir}.holder-${ownerToken}.sh`;
  const script = buildRemoteDeployLockScript(lockDir, ownerToken);
  // wsl.exe will first reorganize the `bash -lc` parameters through the default shell, and the local `$var` in the script
  // will be expanded to empty before the actual shell is executed. Use pure octal content to write to the disk before executing, while retaining stdin for the release marker.
  // The lock script only uses POSIX syntax, is explicitly executed with sh, and is compatible with Alpine/BusyBox and other remote ends without bash.
  return [
    "set -eu",
    `mkdir -p ${quotePosixPathArg(posix.dirname(scriptPath))}`,
    `printf '%b' ${quotePosixShellArg(encodePosixOctal(script))} > ${quotePosixPathArg(scriptPath)}`,
    `trap ${quotePosixShellArg(`rm -f ${quotePosixPathArg(scriptPath)}`)} EXIT HUP INT TERM`,
    `sh ${quotePosixPathArg(scriptPath)}`,
  ].join("\n");
}

function createStreamClosePromise(stream: StdioStream): {
  promise: Promise<number>;
  dispose(): void;
} {
  let disposable: { dispose(): void } | undefined;
  const promise = new Promise<number>((resolve) => {
    disposable = stream.onClose((code) => resolve(code));
  });
  return {
    promise,
    dispose() {
      disposable?.dispose();
    },
  };
}

export async function acquireRemoteDeployLock(
  backend: IRemoteBackend,
  options: AcquireRemoteDeployLockOptions = {},
): Promise<RemoteDeployLockHandle> {
  const ownerToken = options.ownerToken?.trim() || randomUUID();
  const lockDir = options.lockDir?.trim() || `${REMOTE_BASE}/.deploy.lock`;
  const acquireTimeoutMs = Math.max(
    1,
    Math.floor(options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS),
  );
  const releaseTimeoutMs = Math.max(
    1,
    Math.floor(options.releaseTimeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS),
  );
  const acquiredMarker = `zcode-deploy-lock-acquired:${ownerToken}`;
  const releaseMarker = `zcode-deploy-lock-release:${ownerToken}`;
  const stream = await backend.exec(buildRemoteDeployLockCommand(lockDir, ownerToken));
  const close = createStreamClosePromise(stream);
  let stderrText = "";
  const onStderr = (chunk: Buffer | string) => {
    stderrText = `${stderrText}${chunk.toString()}`.slice(-MAX_LOCK_STDERR_LENGTH);
  };
  stream.stderr.on("data", onStderr);

  try {
    await new Promise<void>((resolve, reject) => {
      let stdoutBuffer = "";
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        stream.stdout.off("data", onStdout);
        if (timeout) {
          clearTimeout(timeout);
        }
      };
      const onStdout = (chunk: Buffer | string) => {
        stdoutBuffer = `${stdoutBuffer}${chunk.toString()}`.slice(-MAX_LOCK_STDERR_LENGTH);
        if (!stdoutBuffer.includes(acquiredMarker) || settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve();
      };
      const onTimeout = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        // When other owners continue to heartbeat, stale recovery will never be triggered, and the waiter will hang permanently.
        // After the deadline, only the stream of this waiter is destroyed, the remote lock is not deleted, and the shared backend is not disposed.
        destroyLockStreamBestEffort(stream);
        reject(
          new Error(
            `[deploy-lock] lock acquisition timed out after ${acquireTimeoutMs}ms (owner=${ownerToken})${stderrText.trim() ? `: ${stderrText.trim()}` : ""}`,
          ),
        );
      };
      // Install deadline first and then subscribe to stdout; some streams will spit out buffer markers synchronously when registering data listener.
      // If the order is reversed, the timer created after the marker has been resolved will remain until the deadline.
      timeout = setTimeout(onTimeout, acquireTimeoutMs);
      stream.stdout.on("data", onStdout);
      void close.promise.then((code) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(
          new Error(
            `[deploy-lock] lock-holder exited before acquisition (code=${code})${stderrText.trim() ? `: ${stderrText.trim()}` : ""}`,
          ),
        );
      });
    });
  } catch (error) {
    stream.stderr.off("data", onStderr);
    close.dispose();
    throw error;
  }

  let releasePromise: Promise<void> | null = null;
  return {
    ownerToken,
    release() {
      if (releasePromise) {
        return releasePromise;
      }
      releasePromise = (async () => {
        try {
          stream.stdin.write(`${releaseMarker}\n`);
          stream.stdin.end();
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const timeoutError = new Error(
            `[deploy-lock] lock-holder release timed out after ${releaseTimeoutMs}ms (owner=${ownerToken})${stderrText.trim() ? `: ${stderrText.trim()}` : ""}`,
          );
          let code: number;
          try {
            code = await Promise.race([
              close.promise,
              new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(() => reject(timeoutError), releaseTimeoutMs);
              }),
            ]);
          } catch (error) {
            if (error === timeoutError) {
              // The remote half-open or the loss of the close event will cause deployServer to be permanently stuck in finally.
              // After the deadline, only the stdio of the current owner is destroyed, and the subsequent dispose of the backend takes over the recycling of the underlying connection.
              destroyLockStreamBestEffort(stream);
            }
            throw error;
          } finally {
            if (timeout) {
              clearTimeout(timeout);
            }
          }
          if (code !== 0) {
            throw new Error(
              `[deploy-lock] lock-holder release failed (code=${code})${stderrText.trim() ? `: ${stderrText.trim()}` : ""}`,
            );
          }
        } finally {
          stream.stderr.off("data", onStderr);
          close.dispose();
        }
      })();
      return releasePromise;
    },
  };
}
