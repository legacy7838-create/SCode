import { spawnSync } from "node:child_process";

// Linux XDG desktop integrated shared infrastructure: deep link registration (desktopLinuxDeepLinkRegistration)
// Shared with AppImage icon installation (desktopLinuxAppImageIcon), it is an independent module to avoid the mutual dependence between the two to form a loop.

export const XDG_COMMAND_TIMEOUT_MS = 2_000;

export interface LinuxDeepLinkRegistrationLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export interface LinuxDesktopCommandResult {
  status: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
  stderr?: string;
}

export type LinuxDesktopCommandRunner = (
  command: string,
  args: string[],
) => LinuxDesktopCommandResult;

export function runXdgCommand(command: string, args: string[]): LinuxDesktopCommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: XDG_COMMAND_TIMEOUT_MS,
  });
  // When encoding: "utf8", stderr is already a string, and there is no need to be compatible with the Buffer branch.
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    stderr: result.stderr,
  };
}
