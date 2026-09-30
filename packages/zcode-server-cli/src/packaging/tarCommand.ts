import { existsSync } from "node:fs";
import { join } from "node:path";

// Windows: Git Bash may prepend GNU tar to PATH - it will treat `C:` in the archive parameter as the remote host,
// It is also not possible to write zip with the .zip suffix, so System32 bsdtar is explicitly parsed and fails-fast instead of fallback when missing.
// PATH. Non-Windows hosts return "tar" for PATH resolution, System32 is an implementation detail of Windows only.
export function resolveHostTarCommand(): string {
  if (process.platform !== "win32") return "tar";
  const system32Tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  if (!existsSync(system32Tar)) {
    throw new Error(
      `System32 tar.exe missing (${system32Tar}); Windows staging requires the OS-bundled bsdtar`,
    );
  }
  return system32Tar;
}

/** The COPYFILE_DISABLE check must match both the bare `tar` form and the System32 tar.exe absolute path form. */
export function isTarCommand(command: string): boolean {
  return command === "tar" || command.endsWith("\\tar.exe") || command.endsWith("/tar");
}
