import { access } from "node:fs/promises";
import { join } from "node:path";

export interface BundledAgentWiring {
  ZCODE_AGENT_SERVER_COMMAND: string;
  ZCODE_AGENT_SERVER_ARGS_JSON: string;
}

export function createReleaseAgentWiring(
  runtimeRoot: string,
  runtimeNode: string,
  env: Record<string, string | undefined>,
): BundledAgentWiring | null {
  if (env.ZCODE_AGENT_SERVER_COMMAND?.trim()) return null;
  return {
    ZCODE_AGENT_SERVER_COMMAND: runtimeNode,
    ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify([
      join(runtimeRoot, "zcode.cjs"),
      "app-server",
      "--stdio",
    ]),
  };
}

/**
 * Inside a release package, Core is neither in the monorepo nor has an Electron runtime, so
 * `zcodeAgentProcessManager`'s default resolution chain (monorepo dev → Electron → remotely deployed binary) all miss.
 * Here the bundled `zcode.cjs` is injected as the agent launch command; env override is the highest priority in that
 * resolution chain, so an explicitly configured `ZCODE_AGENT_SERVER_COMMAND` always wins, while dev mode
 * (no zcode.cjs next to the entry point) is unaffected.
 */
export async function resolveBundledAgentWiring(
  entryDir: string,
  env: Record<string, string | undefined>,
): Promise<BundledAgentWiring | null> {
  if (env.ZCODE_AGENT_SERVER_COMMAND?.trim()) {
    return null;
  }
  const bundlePath = join(entryDir, "zcode.cjs");
  try {
    await access(bundlePath);
  } catch {
    return null;
  }
  return {
    ZCODE_AGENT_SERVER_COMMAND: process.execPath,
    ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify([bundlePath, "app-server", "--stdio"]),
  };
}
