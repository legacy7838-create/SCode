import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ZCODE_PLUGIN_HOST_COMMAND } from "@zcode/contracts/plugins";
import {
  getCapturedZCodeCuaBrokerCredentials,
  ZCODE_CUA_BROKER_SOCKET_ENV_KEY,
  ZCODE_CUA_NODE_REPL_HOST_ENV_KEY,
} from "@zcode/shared/runtime-env";
import { ZCODE_CUA_OFFICIAL_PLUGIN_ID, ZCODE_PLUGIN_ID_ENV_KEY } from "@zcode/shared/mcp";
import type { RunContext } from "@zcode/shared-types";

const HOST_USAGE = `${ZCODE_PLUGIN_HOST_COMMAND} <server-path> [-- <server-arg>...]`;

type HostedPluginModule = {
  main?: unknown;
};

export function isPluginHostInvocation(argv: readonly string[]): boolean {
  return argv[0] === ZCODE_PLUGIN_HOST_COMMAND;
}

// __zcode-plugin-host runs the MCP server (server.js) of the official plugin in the agent sub-process.
// The applyCliRuntimeEnvSanitization of the CLI entry main.ts will first remove the broker token from process.env.
// In-process capture; therefore this is the last host boundary to recover the bearer token. capture itself only proves a certain
// The Agent process has received Helper credentials, which cannot prove that the currently passed in server is the official zcode-cua:
// The token is restored to any server path simply by the existence of capture, and third-party/replaced plug-ins can use this to obtain CUA.
// The TCC capabilities of the broker. The plugin id written authoritatively by the resolver and the complete set of capture credentials must be verified at the same time.
// and canonical broker socket; if any field does not match, it will be rejected before importing to avoid exposing the token after loading untrusted modules.
export async function runPluginHostCommand(ctx: RunContext, argv: string[]): Promise<number> {
  if (argv.length < 1) {
    ctx.stderr.write(`Usage: ${HOST_USAGE}\n`);
    return 1;
  }

  const [rawServerPath, ...serverArgs] = argv;

  try {
    if (rawServerPath === undefined) {
      throw new Error("Plugin server path is required.");
    }

    const serverPath = resolve(rawServerPath);
    if (!existsSync(serverPath)) {
      throw new Error("Plugin server file does not exist.");
    }
    const capturedBrokerCredentials = getCapturedZCodeCuaBrokerCredentials();
    assertCapturedBrokerLaunchIsAuthorized(capturedBrokerCredentials);
    const module = (await import(pathToFileURL(serverPath).href)) as HostedPluginModule;
    if (typeof module.main !== "function") {
      throw new Error("Plugin server does not export main().");
    }

    const originalArgv = process.argv;
    const originalBrokerSocket = process.env[ZCODE_CUA_BROKER_SOCKET_ENV_KEY];
    // shared node_repl restores the same credential group to the environment, read by the broker bridge; old standalone CUA
    // MCP no longer has an execution entry.
    process.argv = [process.execPath, serverPath, ...serverArgs];
    if (capturedBrokerCredentials.socket && process.env[ZCODE_CUA_NODE_REPL_HOST_ENV_KEY] === "1") {
      process.env[ZCODE_CUA_BROKER_SOCKET_ENV_KEY] = capturedBrokerCredentials.socket;
    }
    try {
      await module.main();
    } finally {
      process.argv = originalArgv;
      if (originalBrokerSocket === undefined) {
        delete process.env[ZCODE_CUA_BROKER_SOCKET_ENV_KEY];
      } else {
        process.env[ZCODE_CUA_BROKER_SOCKET_ENV_KEY] = originalBrokerSocket;
      }
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`Plugin host failed: ${message}\n`);
    return 1;
  }
}

type CapturedBrokerCredentials = ReturnType<typeof getCapturedZCodeCuaBrokerCredentials>;

function assertCapturedBrokerLaunchIsAuthorized(credentials: CapturedBrokerCredentials): void {
  const hasCapturedCredentials = Boolean(credentials.socket || credentials.pluginAuthority);
  if (!hasCapturedCredentials) return;

  const pluginId = process.env[ZCODE_PLUGIN_ID_ENV_KEY]?.trim().toLowerCase();
  // There is no token in the credential group anymore: the entire platform of broker is changed to identity mode (Helper determines the connection according to the peer code signature),
  // CapturedCuaBrokerCredentials of shared/runtimeEnv.ts only has socket + pluginAuthority
  // (+refreshMarker). `credentials.token` can no longer be read here; token has been removed from the credentials group.
  // Residual readers can only be discovered by the CLI's own typecheck (the root `pnpm typecheck` does not include apps/zcode-cli).
  // socket + pluginAuthority must be paired (authority is the provenance written in the node_repl configuration by bootstrap
  // Random number, core recognizes the official server accordingly); the capture side only takes snapshots when paired, and half of the group will be cleared and fail-closed.
  // Verification cannot require complete tokens - identity mode credentials do not have tokens, and strong verification will allow the node_repl host to start immediately.
  // Exit ("connection closed during the server/discover probe"), the tool surface is empty.
  if (
    credentials.socket === undefined ||
    credentials.pluginAuthority === undefined ||
    pluginId !== ZCODE_CUA_OFFICIAL_PLUGIN_ID ||
    process.env[ZCODE_CUA_NODE_REPL_HOST_ENV_KEY] !== "1"
  ) {
    throw new Error(
      "Captured ZCode CUA broker credentials may only launch the trusted shared node_repl host",
    );
  }
}
