import { access } from "node:fs/promises";

function normalizeWindowsCommandFragment(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

export async function isDelegatedWindowsExplorerExit(
  error: unknown,
  appPath: string,
  args: string[],
  candidate: string,
): Promise<boolean> {
  if (process.platform !== "win32" || typeof error !== "object" || error === null) {
    return false;
  }

  const execError = error as {
    code?: unknown;
    killed?: unknown;
    signal?: unknown;
    cmd?: unknown;
    stderr?: unknown;
    message?: unknown;
  };
  if (
    execError.code !== 1 ||
    execError.killed !== false ||
    execError.signal !== null ||
    typeof execError.cmd !== "string" ||
    typeof execError.message !== "string" ||
    !execError.message.startsWith("Command failed:") ||
    (typeof execError.stderr === "string" && execError.stderr.trim())
  ) {
    return false;
  }

  const normalizedCommand = normalizeWindowsCommandFragment(execError.cmd);
  const matchesInvokedCommand = [appPath, ...args].every((fragment) =>
    normalizedCommand.includes(normalizeWindowsCommandFragment(fragment)),
  );
  if (!matchesInvokedCommand) {
    return false;
  }

  try {
    // Explorer's code=1 may also mean "Delegated" or "Target not accessible". UNC targets only
    // Only when it is indeed accessible at the same time can the exit form of a known commission be regarded as successful.
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}
