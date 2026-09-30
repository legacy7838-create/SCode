import { installNativeRpcBytesPort } from "@zcode/rpc/native";
import { disposeServiceResourcesAndWait, getAppConfigDir } from "@zcode/services/node";
import {
  ZCODE_VERSION,
  SERVICE_AUTHORITY_MODE_ENV,
  formatLogPrefix,
  formatZodError,
  helloAckMessageSchema,
} from "@zcode/shared";
import type { HelloMessage, HelloAckMessage } from "@zcode/shared";
import { createStdioServer } from "./stdio.js";
import { registerStdioProcessLifecycle } from "./stdio-lifecycle.js";
import { createStdioServices } from "./stdioServices.js";
import { ensureRemoteServerDeviceMid } from "./stdioDeviceMid.js";
import {
  materializeBundledZCodeBuiltinProviderConfig,
  readBundledZCodeBuiltinProviderConfig,
} from "./bundledZCodeBuiltinProviderConfig.js";

// In stdio mode, all logging goes to stderr
const log = (...args: unknown[]) =>
  console.error(formatLogPrefix("zcode-server:stdio", process.pid), ...args);
const stderrConsoleLog = (...args: unknown[]) => console.error(...args);

// In stdio mode, stdout can only carry RPC frames.
// Previously, info/debug logs in services still went through console.log / console.info,
// and once ordinary text is written into stdout, it directly pollutes the protocol stream, manifesting as remote calls stuck in pending / loading.
// Here at the entry layer, ordinary console output is uniformly redirected to stderr to ensure all service logs no longer corrupt RPC.
console.log = stderrConsoleLog;
console.info = stderrConsoleLog;
console.warn = stderrConsoleLog;
console.debug = stderrConsoleLog;

// --version flag: print version and exit (used by deploy version check)
if (process.argv.includes("--version")) {
  process.stdout.write(ZCODE_VERSION + "\n");
  process.exit(0);
}

// Node-only entrypoint: bind the RPC byte port (Rust CRC32) before any RPC traffic.
installNativeRpcBytesPort();

async function main() {
  // Phase 1: Send hello message
  const hello: HelloMessage = {
    type: "zcode-hello",
    version: ZCODE_VERSION,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
  };
  process.stdout.write(JSON.stringify(hello) + "\n");

  // Phase 2: Wait for hello-ack
  const ack = await waitForAck();
  log(`client connected: ${ack.clientId} (v${ack.version})`);

  // The remote host has no Desktop main, so no one writes telemetry-state.json; services sending to the ZCode endpoint
  // requests lack X-Device-Mid, and Start Plan billing/balance is rejected. The remote server is the lifecycle owner of the local device identity
  // and must ensure deviceMid exists before services are created (see stdioDeviceMid.ts for details).
  await ensureRemoteServerDeviceMid({ log });

  // Phase 3: Initialize services and start stdio RPC server
  const zcodeBuiltinProviderConfigFilePath = await materializeBundledZCodeBuiltinProviderConfig({
    environmentConfigRoot: getAppConfigDir(),
    content: readBundledZCodeBuiltinProviderConfig(),
  });
  const { authorityModeParseResult, services } = createStdioServices({
    env: process.env,
    zcodeBuiltinProviderConfigFilePath,
  });
  if (authorityModeParseResult.invalidRawValue) {
    log(
      `${SERVICE_AUTHORITY_MODE_ENV}=${authorityModeParseResult.invalidRawValue} is invalid, starting with the default local Environment authority mode`,
    );
  }
  const stdioServer = createStdioServer(services);
  registerStdioProcessLifecycle({
    stdin: process.stdin,
    signalSource: process,
    log,
    stopRpc: () => stdioServer.stop(),
    // Desktop Host already waits for disposeServiceResourcesAndWait, but the remote stdio
    // entry still directly calls process.exit, causing its hosted workspace Agent to not finish process tree cleanup in time.
    // The remote server is also a ServiceCollection owner and must follow the same async cleanup contract before exiting.
    dispose: () => disposeServiceResourcesAndWait(services),
    exit: (code) => process.exit(code),
  });
  // The ready log must be after exit listener registration; otherwise, when SSH happens to disconnect right after ready,
  // SIGHUP/SIGTERM may still fall into Node's default handling and bypass Agent cleanup.
  log("stdio mode ready");
}

function waitForAck(): Promise<HelloAckMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Handshake timeout: no hello-ack received within 10s"));
    }, 10_000);

    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        // Remove listener — remaining data in buffer will be consumed by RPC
        process.stdin.removeListener("data", onData);
        clearTimeout(timeout);

        try {
          const rawValue = JSON.parse(line);
          const result = helloAckMessageSchema.safeParse(rawValue);
          if (!result.success) {
            reject(new Error(`Invalid hello-ack: ${formatZodError(result.error)}`));
            return;
          }
          const msg = result.data as HelloAckMessage;
          // If there's remaining data after the newline, push it back
          const remaining = buffer.slice(newlineIdx + 1);
          if (remaining.length > 0) {
            process.stdin.unshift(Buffer.from(remaining, "utf-8"));
          }
          resolve(msg);
        } catch (err) {
          reject(new Error(`Failed to parse hello-ack: ${err}`));
        }
      }
    };

    process.stdin.on("data", onData);
  });
}

main().catch((err) => {
  log("fatal:", err);
  process.exit(1);
});
