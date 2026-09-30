import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  runXdgCommand,
  XDG_COMMAND_TIMEOUT_MS,
  type LinuxDesktopCommandRunner,
  type LinuxDeepLinkRegistrationLogger,
} from "./desktopLinuxXdg.js";

// AppImage user-level icon installation logic removed from desktopLinuxDeepLinkRegistration:
// Icon integration is an optional desktop enhancement. It has different concerns from deep link protocol registration and is separated into modules to facilitate their respective evolutions.

const LINUX_APP_ICON_NAME = "zcode";
const LINUX_APP_ICON_SIZE = "512x512";

function resolveLinuxUserIconFilePath(dataDir: string): string {
  return join(
    dataDir,
    "icons",
    "hicolor",
    LINUX_APP_ICON_SIZE,
    "apps",
    `${LINUX_APP_ICON_NAME}.png`,
  );
}

function copyFileIfChanged(sourcePath: string, targetPath: string): boolean {
  if (existsSync(targetPath) && readFileSync(sourcePath).equals(readFileSync(targetPath))) {
    return false;
  }

  copyFileSync(sourcePath, targetPath);
  return true;
}

function shouldInstallAppImageDesktopIcon(params: {
  env?: { APPIMAGE?: string };
  iconSourcePath?: string;
}): boolean {
  return Boolean(params.env?.APPIMAGE?.trim() && params.iconSourcePath);
}

function installLinuxAppImageDesktopIcon(params: {
  dataDir: string;
  iconSourcePath: string;
  logger: LinuxDeepLinkRegistrationLogger;
  runCommand?: LinuxDesktopCommandRunner;
}): { iconFilePath: string; installed: boolean; changed: boolean } {
  const iconFilePath = resolveLinuxUserIconFilePath(params.dataDir);
  if (!existsSync(params.iconSourcePath)) {
    params.logger.warn(
      "[deep-link] Linux AppImage icon source file is missing, skipping user-level icon installation",
      {
        iconSourcePath: params.iconSourcePath,
        iconFilePath,
      },
    );
    return { iconFilePath, installed: false, changed: false };
  }

  mkdirSync(dirname(iconFilePath), { recursive: true });
  const changed = copyFileIfChanged(params.iconSourcePath, iconFilePath);
  // AppImage direct running will not write Icon=zcode into the hicolor icon theme like the deb installation package.
  // Here, the icon with the same name is completed in the user-level hicolor directory, so that the taskbar/Dock has the opportunity to hit the real icon by pressing desktop entry.
  if (!changed) {
    return { iconFilePath, installed: true, changed };
  }

  const runCommand = params.runCommand ?? runXdgCommand;
  const cacheResult = runCommand("gtk-update-icon-cache", [
    "-f",
    "-t",
    join(params.dataDir, "icons", "hicolor"),
  ]);
  if (cacheResult.error) {
    params.logger.warn("[deep-link] gtk-update-icon-cache is unavailable, skipped", {
      iconFilePath,
      message: cacheResult.error.message,
    });
  } else if (cacheResult.signal === "SIGTERM") {
    params.logger.warn("[deep-link] Linux user-level icon cache refresh timed out, skipped", {
      iconFilePath,
      timeoutMs: XDG_COMMAND_TIMEOUT_MS,
    });
  } else if (cacheResult.status !== 0) {
    params.logger.warn("[deep-link] Linux user-level icon cache refresh failed", {
      iconFilePath,
      status: cacheResult.status,
      stderr: cacheResult.stderr?.trim(),
    });
  }

  return { iconFilePath, installed: true, changed };
}

export function installLinuxAppImageDesktopIconBestEffort(params: {
  dataDir: string;
  env?: { APPIMAGE?: string };
  iconSourcePath?: string;
  logger: LinuxDeepLinkRegistrationLogger;
  runCommand?: LinuxDesktopCommandRunner;
}): { iconFilePath: string; installed: boolean; changed: boolean } | null {
  if (
    !shouldInstallAppImageDesktopIcon({
      env: params.env,
      iconSourcePath: params.iconSourcePath,
    }) ||
    !params.iconSourcePath
  ) {
    return null;
  }

  try {
    return installLinuxAppImageDesktopIcon({
      dataDir: params.dataDir,
      iconSourcePath: params.iconSourcePath,
      logger: params.logger,
      runCommand: params.runCommand,
    });
  } catch (error) {
    params.logger.warn(
      "[deep-link] Linux AppImage icon installation failed, degrading gracefully",
      {
        iconSourcePath: params.iconSourcePath,
        error,
      },
    );
    return null;
  }
}
