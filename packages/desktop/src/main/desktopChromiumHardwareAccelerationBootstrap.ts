import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface ChromiumHardwareAccelerationApp {
  disableHardwareAcceleration(): void;
}

function resolveChromiumHardwareAccelerationSettingsFile(homePath: string = homedir()): string {
  return join(homePath, ".zcode", "v2", "setting.json");
}

function extractBootstrapChromiumHardwareAccelerationEnabled(rawValue: unknown): boolean {
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
    return true;
  }

  const enabled = (
    rawValue as {
      desktopChromiumHardwareAccelerationEnabled?: unknown;
    }
  ).desktopChromiumHardwareAccelerationEnabled;
  return typeof enabled === "boolean" ? enabled : true;
}

function readBootstrapChromiumHardwareAccelerationEnabledFromDisk(
  settingsFile: string = resolveChromiumHardwareAccelerationSettingsFile(),
): boolean {
  if (!existsSync(settingsFile)) {
    return true;
  }

  try {
    const raw = readFileSync(settingsFile, "utf-8");
    return extractBootstrapChromiumHardwareAccelerationEnabled(JSON.parse(raw));
  } catch {
    return true;
  }
}

export function applyEarlyChromiumHardwareAccelerationBootstrap(
  app: ChromiumHardwareAccelerationApp,
  rawSettings?: unknown,
): boolean {
  const enabled =
    rawSettings === undefined
      ? readBootstrapChromiumHardwareAccelerationEnabledFromDisk()
      : extractBootstrapChromiumHardwareAccelerationEnabled(rawSettings);
  if (!enabled) {
    // Electron can only turn off Chromium hardware acceleration before the app is ready.
    // Therefore, after the setting page is saved, it must be read and applied at the earliest stage of the next main process, and cannot wait until whenReady.
    app.disableHardwareAcceleration();
  }
  return enabled;
}
