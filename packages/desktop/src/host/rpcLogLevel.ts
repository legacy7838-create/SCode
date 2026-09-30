import { ZCODE_AGENT_PROVIDER_NOT_READY_CODE } from "@zcode/shared";

type RpcLogLevel = "debug" | "info" | "warn";

/**
 * The host used to log every RPC at `error` level, which made the main log look as if all RPCs
 * had failed. This applies minimal classification based on the message content: FAIL logs at
 * `warn`, the high-frequency output-poll successes log at `debug`, everything else logs at `info`.
 */
export function resolveRpcLogLevel(message: string, ...args: unknown[]): RpcLogLevel {
  // The background details are read once per second, and the success log will continue to be written to the disk; only the success level of the query will be reduced, and the failure diagnosis will be retained.
  if (message.startsWith("[rpc:call] zcode-agent.backgroundBashOutputV4 OK (")) return "debug";

  // When the workspace is bound for the first time, the provider registry will be synchronized after the runtime identity query;
  // This failure with a clear error code is the startup handshake state, not a service downgrade, to avoid leaving a warn in each workspace.
  if (
    message.includes("zcode-session.getWorkspaceRuntimeIdentity FAIL") &&
    args.some(
      (arg) =>
        typeof arg === "object" &&
        arg !== null &&
        "code" in arg &&
        (arg as { code?: unknown }).code === ZCODE_AGENT_PROVIDER_NOT_READY_CODE,
    )
  ) {
    return "info";
  }

  return message.includes(" FAIL ") ? "warn" : "info";
}
