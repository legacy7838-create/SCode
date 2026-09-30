import type { BrowserWindow, MessageBoxReturnValue } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { arch, hostname, platform, release, type, version as osVersion } from "node:os";
import { join } from "node:path";
import { ZCODE_BUILD_TIME, ZCODE_COMMIT, ZCODE_ENV, ZCODE_VERSION } from "@zcode/shared";
import { createCustomAboutDialogHtml } from "./aboutWindow.js";

interface DesktopBuildMetadata {
  appVersion?: string;
  buildCommitId?: string;
  buildTime?: string;
  electronBuilderVersion?: string;
}

interface AboutSnapshot {
  appVersion: string;
  buildCommitId: string;
  buildTime: string;
  environment: string;
  electronVersion: string;
  electronBuilderVersion: string;
  chromiumVersion: string;
  nodeVersion: string;
  v8Version: string;
  osType: string;
  osPlatform: string;
  osRelease: string;
  osVersion: string;
  osArch: string;
  hostname: string;
}

interface AboutSnapshotOptions {
  appVersion?: string;
  buildMetadata?: DesktopBuildMetadata | null;
  environment?: string;
  runtimeVersions?: Pick<NodeJS.ProcessVersions, "electron" | "chrome" | "node" | "v8">;
  osInfo?: {
    type: string;
    platform: string;
    release: string;
    version: string;
    arch: string;
    hostname: string;
  };
}

const ABOUT_APPLICATION_NAME = "ZCode Desktop App";
// The custom About content body is 256x280; if the native window is the same size, the content will fill the transparent window border.
// This gives the BrowserWindow additional background breathing space to prevent the formal About from looking more cramped than the demo.
const ABOUT_WINDOW_WIDTH = 256;
const ABOUT_WINDOW_HEIGHT = 312;
const ABOUT_MESSAGES = {
  aboutTitle: "About ZCode",
  versionLabel: "version",
  okButtonLabel: "OK",
  optimizedForAppleSilicon: "Optimized for Apple Silicon.",
  copyright: (year: number) => `Copyright © ${year} ZCode.`,
};

function normalizeValue(value: string | undefined | null): string {
  if (typeof value !== "string") {
    return "unknown";
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "unknown";
}

function normalizePackageVersion(version: string | undefined): string {
  const normalized = normalizeValue(version);
  return normalized === "unknown" ? normalized : normalized.replace(/^[^\d]*/, "") || normalized;
}

function readJsonFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function resolveBuildMetadataPath(): string {
  return join(import.meta.dirname, "../metadata/build-meta.json");
}

export function readBuildMetadata(
  filePath = resolveBuildMetadataPath(),
): DesktopBuildMetadata | null {
  // Previously, About directly read the constants injected during compilation, and commit/time could only represent the moment of tsup.
  // Cause of the problem: Building and packaging are performed in steps. About in the installation package requires unified metadata of the "final product" rather than a snapshot of a certain compilation sub-step.
  // Here, the build-meta.json generated before packaging is read first; only when the file is missing, it falls back to the compile-time constants.
  return readJsonFile<DesktopBuildMetadata>(filePath);
}

function resolveElectronBuilderVersion(buildMetadata: DesktopBuildMetadata | null): string {
  if (buildMetadata?.electronBuilderVersion) {
    return normalizeValue(buildMetadata.electronBuilderVersion);
  }

  const packageJson = readJsonFile<{ devDependencies?: Record<string, string> }>(
    join(import.meta.dirname, "../../package.json"),
  );
  return normalizePackageVersion(packageJson?.devDependencies?.["electron-builder"]);
}

export function createAboutSnapshot(options: AboutSnapshotOptions = {}): AboutSnapshot {
  const buildMetadata = options.buildMetadata ?? null;
  const runtimeVersions = options.runtimeVersions ?? process.versions;
  const osInfo = options.osInfo ?? {
    type: type(),
    platform: platform(),
    release: release(),
    version: osVersion(),
    arch: arch(),
    hostname: hostname(),
  };

  return {
    appVersion: normalizeValue(options.appVersion ?? buildMetadata?.appVersion ?? ZCODE_VERSION),
    buildCommitId: normalizeValue(buildMetadata?.buildCommitId ?? ZCODE_COMMIT),
    buildTime: normalizeValue(buildMetadata?.buildTime ?? ZCODE_BUILD_TIME),
    environment: normalizeValue(options.environment ?? ZCODE_ENV),
    electronVersion: normalizeValue(runtimeVersions.electron),
    electronBuilderVersion: resolveElectronBuilderVersion(buildMetadata),
    chromiumVersion: normalizeValue(runtimeVersions.chrome),
    nodeVersion: normalizeValue(runtimeVersions.node),
    v8Version: normalizeValue(runtimeVersions.v8),
    osType: normalizeValue(osInfo.type),
    osPlatform: normalizeValue(osInfo.platform),
    osRelease: normalizeValue(osInfo.release),
    osVersion: normalizeValue(osInfo.version),
    osArch: normalizeValue(osInfo.arch),
    hostname: normalizeValue(osInfo.hostname),
  };
}

export function formatAboutDetail(snapshot: AboutSnapshot): string {
  return [
    `Version: ${snapshot.appVersion}`,
    `Commit: ${snapshot.buildCommitId}`,
    `Build Time: ${snapshot.buildTime}`,
    `Environment: ${snapshot.environment}`,
    "",
    `Electron: ${snapshot.electronVersion}`,
    `Electron Builder: ${snapshot.electronBuilderVersion}`,
    `Chromium: ${snapshot.chromiumVersion}`,
    `Node.js: ${snapshot.nodeVersion}`,
    `V8: ${snapshot.v8Version}`,
    "",
    `OS Type: ${snapshot.osType}`,
    `OS Platform: ${snapshot.osPlatform}`,
    `OS Release: ${snapshot.osRelease}`,
    `OS Version: ${snapshot.osVersion}`,
    `OS Arch: ${snapshot.osArch}`,
    `Hostname: ${snapshot.hostname}`,
  ].join("\n");
}

function formatAboutOptimizationLine(
  snapshot: Pick<AboutSnapshot, "osPlatform" | "osArch">,
): string {
  if (snapshot.osPlatform === "darwin" && snapshot.osArch === "arm64") {
    return ABOUT_MESSAGES.optimizedForAppleSilicon;
  }

  return "";
}

function resolveAboutIconPath(isPackaged: boolean): string {
  return isPackaged
    ? join(process.resourcesPath, "icon.png")
    : join(import.meta.dirname, "../../build/icon.png");
}

export async function showAboutDialog(
  parentWindow?: BrowserWindow,
): Promise<MessageBoxReturnValue> {
  const { app, BrowserWindow } = await import("electron");
  const snapshot = createAboutSnapshot({
    appVersion: app.getVersion(),
    buildMetadata: readBuildMetadata(),
  });
  // Previously, only macOS used self-drawn About, while Windows/Linux still used the native message box.
  // Cause of the problem: The layout, icon, and button styles of the native message boxes on each platform are very different, and the macOS reference style cannot be reused.
  // Self-drawn modal is used uniformly here to ensure that About’s brand display and multi-language copywriting are consistent on three ends.
  const iconPath = resolveAboutIconPath(app.isPackaged);
  const aboutWindow = new BrowserWindow({
    width: ABOUT_WINDOW_WIDTH,
    height: ABOUT_WINDOW_HEIGHT,
    parent: parentWindow && !parentWindow.isDestroyed() ? parentWindow : undefined,
    modal: Boolean(parentWindow && !parentWindow.isDestroyed()),
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: ABOUT_MESSAGES.aboutTitle,
    icon: existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  aboutWindow.setMenuBarVisibility(false);
  aboutWindow.once("ready-to-show", () => {
    aboutWindow.show();
  });
  void aboutWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(
      createCustomAboutDialogHtml({
        applicationName: ABOUT_APPLICATION_NAME,
        appVersion: snapshot.appVersion,
        copyright: ABOUT_MESSAGES.copyright(new Date().getFullYear()),
        optimizationLine: formatAboutOptimizationLine(snapshot),
        versionLabel: ABOUT_MESSAGES.versionLabel,
        okButtonLabel: ABOUT_MESSAGES.okButtonLabel,
      }),
    )}`,
  );
  return { response: 0, checkboxChecked: false };
}
