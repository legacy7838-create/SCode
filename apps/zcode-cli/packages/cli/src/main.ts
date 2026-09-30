import { interceptTuiStderr, isTuiInvocation } from "./tui-stderr.js";
import { installNativeRpcBytesPort } from "@zcode/rpc/native";
import { interceptKnownRuntimeWarnings } from "./runtime-warnings.js";
import { installStderrConsoleBoundary } from "./protocol-console.js";
import { setCliProcessTitle } from "./process-name.js";
import { applyCliRuntimeEnvSanitization } from "./env.js";
import { ensureSeaRuntimeTools } from "./sea-runtime-tools.js";
import { installSeaNativeRuntime } from "./sea-native-runtime.js";
import { isPluginHostInvocation, runPluginHostCommand } from "./plugin-host-command.js";
import { scheduleCliExitWatchdog } from "./shutdown.js";
import { installCliProcessErrorBoundary } from "./process-errors.js";
import { installProtocolStderrBoundary } from "./protocol-stderr.js";
import { createProtocolProcessLifecycle } from "./protocol-lifecycle.js";
import { isProtocolServerInvocation } from "./arguments.js";

// Native payload bootstrap. Both calls below must run before ANY loadNative() consumer,
// and they must run in this order:
//
//   1. installSeaNativeRuntime() — in a SEA binary there is no filesystem path to the
//      compiled .node files, so they are extracted from the blob into a content-addressed
//      cache and ZCODE_NATIVE_DIR is pointed at it. It is async because it does real disk
//      IO (see ./sea-native-runtime.ts).
//   2. installNativeRpcBytesPort() — binds the RPC byte port to the Rust CRC32. It calls
//      loadNative() synchronously and throws when a binary is missing, which is exactly the
//      "no JavaScript fallback" contract (docs/specs/rust-native-ports.md invariant 1).
//
// Every rpcBytesPort() call site is inside a function, so binding one microtask later than
// module scope is safe: the only ordering requirement is "before any RPC traffic", and that
// traffic starts further down in main(). Outside SEA step 1 is a no-op, because
// node_modules/@zcode/rust already resolves the same binaries there.
void main();
async function main(): Promise<void> {
  await installSeaNativeRuntime();
  installNativeRpcBytesPort();
  const argv = process.argv.slice(2);
  // Storage mode can also run in Host Worker, and the process name of the entire Host cannot be modified.
  if (!argv.includes("--prepare-storage")) setCliProcessTitle();
  // There may still be a small number of paths in the real zcode CLI process that directly read process.env.
  // The entrance first cleans the NODE_ENV, proxy and certificate variables injected by the user shell; the network variables are only sealed for subsequent restoration by the Bash/tool ​​sub-process.
  applyCliRuntimeEnvSanitization(process.env);
  const isProtocol = isProtocolServerInvocation(argv);
  const isTui = isTuiInvocation(argv);
  if (isProtocol) installProtocolStderrBoundary(process.stderr);
  const lifecycle =
    isProtocol && !argv.includes("--prepare-storage")
      ? createProtocolProcessLifecycle()
      : undefined;
  // The stdout of app-server/agent-server is a strict ZCode Protocol frame channel, and the third-party SDK
  // Ordinary output such as console.debug cannot be written directly to stdout. Must be loaded before run/bootstrap
  // The process-level console is uniformly directed to stderr, otherwise any dependent line of ordinary logs will trigger a crash in the transport layer JSON parsing.
  // TUI also has exclusive access to stdout; the AI ​​SDK's first prompt uses console.info and cannot bypass stderr capture.
  const restoreConsole =
    isProtocol || isTui ? installStderrConsoleBoundary(process.stderr) : undefined;
  const runtimeWarnings = interceptKnownRuntimeWarnings(process.stderr);
  const tuiStderr = isTui ? interceptTuiStderr(process.stderr) : undefined;
  const stderr = tuiStderr?.passthrough ?? process.stderr;
  const disposeProcessErrorBoundary = isProtocol
    ? installCliProcessErrorBoundary({
        stderr,
        onFatal: (reason) => {
          if (lifecycle)
            lifecycle.requestShutdown(new Error("Uncaught process error", { cause: reason }));
          else process.exit(1);
        },
      })
    : undefined;

  try {
    if (!argv.includes("--prepare-storage"))
      Object.assign(process.env, await ensureSeaRuntimeTools());
    lifecycle?.signal.throwIfAborted();
    const context = {
      argv,
      stderr,
      stdin: process.stdin,
      stdout: process.stdout,
    };
    // plugin-host only hosts plugins; importing run first will evaluate the Agent, tool registry and workflow modules.
    // Even if the AgentRuntime is not ultimately created, each MCP child process will hold the entire set of business dependencies.
    if (isPluginHostInvocation(argv)) {
      process.exitCode = await runPluginHostCommand(context, argv.slice(1));
      return;
    }
    if (!argv.includes("--prepare-storage")) {
      const { prepareCliProviderRuntimeEnv } = await import("./provider-runtime-env.js");
      Object.assign(
        process.env,
        await prepareCliProviderRuntimeEnv({
          argv,
          env: process.env,
        }),
      );
    }
    lifecycle?.signal.throwIfAborted();
    const { run } = await import("./run.js");
    lifecycle?.signal.throwIfAborted();
    const exitCode = await run(context, {
      protocolLifecycle: lifecycle,
      protocolInput: lifecycle?.input,
    });

    process.exitCode = exitCode;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${message}\n`);
    process.exitCode = 1;
  } finally {
    await waitForPendingWarnings();
    // Lifetime and stderr guard are retained until actual exit, late errors cannot recover from recursive writes to the bad stream.
    if (lifecycle) {
      await lifecycle.complete(normalizeProcessExitCode(process.exitCode));
    } else {
      if (tuiStderr) {
        tuiStderr.restore();
      }
      runtimeWarnings.restore();
      disposeProcessErrorBoundary?.();
      // main() of plugin-host will return after MCP server.connect() completes, but at this time
      // stdio handle is the survival condition of the service. A one-time CLI watchdog cannot misjudge this as a leak and force abort.
      const exitCode = normalizeProcessExitCode(process.exitCode);
      if (!isPluginHostInvocation(argv) || exitCode !== 0) {
        scheduleCliExitWatchdog({ exitCode });
      }
      restoreConsole?.();
    }
  }
}

function normalizeProcessExitCode(exitCode: string | number | null | undefined): number {
  if (typeof exitCode === "number" && Number.isInteger(exitCode)) return exitCode;
  if (typeof exitCode === "string") {
    const parsed = Number(exitCode);
    if (Number.isInteger(parsed)) return parsed;
  }
  return 0;
}

function waitForPendingWarnings(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
