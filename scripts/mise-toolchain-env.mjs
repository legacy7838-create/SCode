import { delimiter, dirname } from "node:path";

/**
 * Let all child processes use the same Node runtime as the launcher.
 *
 * `mise run` executes the TOML task through the shell; when another set of Node appears
 * in front of the PATH of the subshell, pnpm will use the wrong runtime to start the package script.
 * Even if the task itself has the correct version selected by mise. Set the Node directory of the launcher to the beginning,
 * The entire child process link can be fixed without relying on the layout of the user's home directory.
 */
export function withPinnedNodePath(env, nodeExecutablePath) {
  const nodeDirectory = dirname(nodeExecutablePath);
  // Windows' Node environment objects usually use `Path`. Only reading uppercase `PATH` will change pnpm.cmd
  // The directory where it was located was lost from the child process environment, causing the internal pnpm call of dev:desktop to fail.
  const pathKey = typeof env.PATH === "string" ? "PATH" : "Path";
  const existingPath = typeof env[pathKey] === "string" ? env[pathKey] : "";
  const pathEntries = existingPath
    .split(delimiter)
    .filter(Boolean)
    .filter((entry) => entry !== nodeDirectory);

  return {
    ...env,
    [pathKey]: [nodeDirectory, ...pathEntries].join(delimiter),
  };
}
