// The remote ZCode Agent runs in the form of "independent node + compiled product zcode.cjs" instead of the native binary of node embedded in each platform.
// During remote deployment, there is already an independent node (used to run zcode-server.cjs), and the agent can reuse it to execute zcode.cjs.
//
// Deployment layout: put zcode.cjs into agents/<provider>/zcode.cjs, and write a wrapper with the same name - which is resolver
// The executable entry expected to be found (such as agents/glm/zcode-agent) - which will execute zcode.cjs using the remote node.
// In this way, the provider runtime resolver does not need to distinguish between native/JS, and can still find the executable file zcode-agent.
// Development mode and production mode share the same wrapper semantics.

export const REMOTE_AGENT_BUNDLE_NAME = "zcode.cjs";

export function buildRemoteAgentBundleWrapper(runtimeResourceDir: string): string {
  return [
    "#!/bin/sh",
    "set -eu",
    'runtime_root="${ZCODE_SERVER_RUNTIME_ROOT:-$HOME/.zcode/server}"',
    `exec "$runtime_root/node" "$HOME/.zcode/server/agents/${runtimeResourceDir}/${REMOTE_AGENT_BUNDLE_NAME}" "$@"`,
    "",
  ].join("\n");
}

export function isRemoteAgentBundleWrapperCurrent(
  content: string,
  runtimeResourceDir: string,
): boolean {
  return content.replace(/\r\n/g, "\n") === buildRemoteAgentBundleWrapper(runtimeResourceDir);
}
