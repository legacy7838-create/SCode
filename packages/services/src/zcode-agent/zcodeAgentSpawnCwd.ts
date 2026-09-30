import { stat } from "node:fs/promises";

/** Only picks the execution directory and does not catch database errors; when no usable fallback directory exists, the original path is kept so normal startup reporting handles it. */
export async function resolveZCodeAgentSpawnCwd(
  options: { requestedCwd: string; workspacePath: string; spawnFallbackCwd?: string },
  probe: (path: string) => Promise<{ isDirectory(): boolean }> = stat,
): Promise<{ cwd: string; usedFallback: boolean; cwdExists: boolean }> {
  const usable = async (path: string | undefined) => {
    if (!path) return false;
    try {
      return (await probe(path)).isDirectory();
    } catch {
      // Old agents uniformly use standby cwds for expired history directories; ENOTDIR/EACCES must also maintain this semantics.
      return false;
    }
  };
  const cwdExists = await usable(options.requestedCwd);
  if (
    options.requestedCwd === options.workspacePath &&
    !cwdExists &&
    (await usable(options.spawnFallbackCwd))
  )
    return { cwd: options.spawnFallbackCwd!, usedFallback: true, cwdExists: true };
  return { cwd: options.requestedCwd, usedFallback: false, cwdExists };
}
