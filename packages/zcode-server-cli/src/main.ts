import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runServerCli } from "./cli.js";
import { installNativeRpcBytesPort } from "@zcode/rpc/native";
import { resolveBundledAgentWiring } from "./runtime/agentWiring.js";

// Automatic wiring is only passed in as an explicit dependency of this CLI and cannot pollute the global env; when candidate release is started
// Supervisor will be recalculated according to the candidate runtime to avoid inheriting the zcode.cjs of the old release.
const bundledAgentWiring = await resolveBundledAgentWiring(
  dirname(fileURLToPath(import.meta.url)),
  process.env,
);

// Node-only entrypoint: bind the RPC byte port (Rust CRC32) before any RPC traffic.
installNativeRpcBytesPort();

void runServerCli(
  process.argv.slice(2),
  {
    stdout: process.stdout,
    stderr: process.stderr,
    confirm: async (prompt) => {
      process.stdout.write(prompt);
      return await new Promise<string>((resolve) => {
        process.stdin.once("data", (chunk) => resolve(String(chunk).trim()));
      });
    },
  },
  { bundledAgentWiring },
).then((exitCode) => {
  process.exitCode = exitCode;
});
