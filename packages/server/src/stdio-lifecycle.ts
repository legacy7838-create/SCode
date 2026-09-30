import type { Readable } from "node:stream";

const TERMINATION_SIGNALS = ["SIGHUP", "SIGTERM", "SIGINT"] as const;
const DEFAULT_RPC_STOP_TIMEOUT_MS = 1_000;
const DEFAULT_SERVICE_DISPOSE_TIMEOUT_MS = 3_500;

type StdioShutdownPhase = "rpc-stop" | "service-dispose";

interface StdioProcessSignalSource {
  on(signal: (typeof TERMINATION_SIGNALS)[number], listener: () => void): unknown;
}

interface StdioProcessLifecycleOptions {
  stdin: Readable;
  signalSource: StdioProcessSignalSource;
  log: (...args: unknown[]) => void;
  stopRpc: () => Promise<void>;
  dispose: () => Promise<void>;
  exit: (code: number) => never | void;
  shutdownTimeoutMs?: number;
  rpcStopTimeoutMs?: number;
  serviceDisposeTimeoutMs?: number;
}

export function registerStdioProcessLifecycle(options: StdioProcessLifecycleOptions): void {
  const { stdin, signalSource, log, stopRpc, dispose, exit } = options;
  const rpcStopTimeoutMs = Math.max(
    options.rpcStopTimeoutMs ?? options.shutdownTimeoutMs ?? DEFAULT_RPC_STOP_TIMEOUT_MS,
    0,
  );
  const serviceDisposeTimeoutMs = Math.max(
    options.serviceDisposeTimeoutMs ??
      options.shutdownTimeoutMs ??
      DEFAULT_SERVICE_DISPOSE_TIMEOUT_MS,
    0,
  );
  let shutdownStarted = false;
  let requestedExitCode = 0;

  const requestShutdown = (exitCode: number): void => {
    requestedExitCode = Math.max(requestedExitCode, exitCode);
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;

    void (async () => {
      const runPhase = async (
        phase: StdioShutdownPhase,
        operation: () => Promise<void>,
        failureMessage: string,
        timeoutMs: number,
      ): Promise<boolean> => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const operationResult = operation().then(
          () => ({ kind: "completed" as const }),
          (error: unknown) => ({ kind: "failed" as const, error }),
        );
        const timedOut = new Promise<{ kind: "timed-out" }>((resolve) => {
          // The timer cannot be unref'd; otherwise, when the external Promise is permanently pending, it cannot independently guarantee closure.
          timeout = setTimeout(() => resolve({ kind: "timed-out" }), timeoutMs);
        });
        const result = await Promise.race([operationResult, timedOut]);
        if (timeout) {
          clearTimeout(timeout);
        }
        if (result.kind === "timed-out") {
          log("stdio shutdown timed out", { phase, timeoutMs });
          return false;
        }
        if (result.kind === "failed") {
          log(failureMessage, result.error);
          return false;
        }
        return true;
      };

      // The entire cleanup cannot have just one race; once stopRpc times out, it directly exits,
      // and service dispose never gets a chance to shut down the Agent child process. The two external async boundaries must each be bounded and advance independently.
      if (
        !(await runPhase("rpc-stop", stopRpc, "stdio shutdown RPC stop failed", rpcStopTimeoutMs))
      ) {
        requestedExitCode = 1;
      }
      if (
        !(await runPhase(
          "service-dispose",
          dispose,
          "stdio shutdown cleanup failed",
          serviceDisposeTimeoutMs,
        ))
      ) {
        requestedExitCode = 1;
      }
      log("stdio shutdown completed", { exitCode: requestedExitCode });
      exit(requestedExitCode);
    })();
  };

  // A remote project at rest may have no client->server RPC input for a long time, but the window remains open.
  // Can no longer actively exit based on idle time; only end the remote server when stdio is explicitly closed or errors,
  // letting the remote connection lifecycle follow the user closing the project/application or the underlying SSH disconnection.
  stdin.on("end", () => {
    log("stdin closed, shutting down");
    requestShutdown(0);
  });
  stdin.on("error", (error) => {
    log("stdin error, shutting down", error);
    requestShutdown(1);
  });
  for (const signal of TERMINATION_SIGNALS) {
    signalSource.on(signal, () => {
      // SSH disconnection may manifest as stdin EOF on different sshd/shells, or may first send a signal to the foreground process.
      // Both types of entry must enter the same idempotent cleanup chain, otherwise the detached Agent would bypass parent process exit and become an orphan.
      log("termination signal received, shutting down", signal);
      requestShutdown(1);
    });
  }
}
