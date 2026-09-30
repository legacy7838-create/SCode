import type { BrowserWindow, NativeImage } from "electron";
import { DEFAULT_ZCODE_ENDPOINT_ORIGIN, buildZCodeEndpointUrls } from "@zcode/shared";

interface ArchitectureMismatch {
  /** The current running binary architecture, such as x64. */
  binaryArch: string;
  /** It is recommended to install the native architecture. Currently, the translation operation will only fall back to arm64. */
  nativeArch: string;
}

interface DetectArchitectureMismatchOptions {
  platform?: NodeJS.Platform;
  binaryArch?: string;
  /**
   * Electron's app.runningUnderARM64Translation:
   * True when the x64/x86 installation package is translated to run on arm64 hardware
   * (Rosetta on macOS, Windows on ARM). This is a typical scenario of "installing the wrong architecture".
   */
  runningUnderARM64Translation?: boolean;
}

/**
 * Determine whether the current process is running under the "wrong architecture".
 *
 * The reason why runningUnderARM64Translation is used instead of directly comparing process.arch and os.arch():
 * When Node runs the x64 package on Apple Silicon, os.arch() will also return "x64" (transparently translated by Rosetta).
 * No difference can be found by simply comparing the two. The translation flag is the only reliable signal.
 */
function detectArchitectureMismatch(
  options: DetectArchitectureMismatchOptions = {},
): ArchitectureMismatch | null {
  const platform = options.platform ?? process.platform;
  const binaryArch = options.binaryArch ?? process.arch;
  const translated = options.runningUnderARM64Translation ?? false;

  if (!translated) {
    return null;
  }
  // ARM64 translation runs only on macOS/Windows; other platforms allow it directly to avoid false positives.
  if (platform !== "darwin" && platform !== "win32") {
    return null;
  }

  return { binaryArch, nativeArch: "arm64" };
}

function resolveArchitectureDownloadUrl(endpointOrigin = DEFAULT_ZCODE_ENDPOINT_ORIGIN): string {
  // Be consistent with external links such as changelog and point to the official website download page.
  return `${buildZCodeEndpointUrls(endpointOrigin).origin}/en`;
}

interface ArchitectureMismatchDialogText {
  title: string;
  message: string;
  detail: string;
  downloadButton: string;
  dismissButton: string;
}

interface ArchitectureGuardLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

/**
 * Detects at startup whether the architecture matches; if the user installed a build of the wrong
 * architecture, a dialog prompts them to download the native build.
 * Non-blocking: once detection hits, the dialog is shown asynchronously and does not hold up the
 * main UI from loading.
 */
export async function maybeWarnArchitectureMismatch(options: {
  logger: ArchitectureGuardLogger;
  parentWindow?: BrowserWindow | null;
  icon?: NativeImage;
}): Promise<void> {
  const { app, dialog, shell } = await import("electron");

  const mismatch = detectArchitectureMismatch({
    runningUnderARM64Translation: app.runningUnderARM64Translation,
  });
  if (!mismatch) {
    return;
  }

  options.logger.warn(
    `[architecture] architecture mismatch detected: running ${mismatch.binaryArch}, this machine is ${mismatch.nativeArch} (running under translation)`,
  );

  const text: ArchitectureMismatchDialogText = {
    title: "Architecture Mismatch",
    message: "The installed build does not match your machine",
    detail:
      `You are running the ${mismatch.binaryArch} build, but this machine is ${mismatch.nativeArch}. ` +
      `It is currently running through system translation, which is slower and less power-efficient.\n\n` +
      `Please download and install the native ${mismatch.nativeArch} build for the best performance.`,
    downloadButton: "Download",
    dismissButton: "Not now",
  };
  const dialogOptions = {
    type: "warning" as const,
    buttons: [text.downloadButton, text.dismissButton],
    defaultId: 0,
    cancelId: 1,
    title: text.title,
    message: text.message,
    detail: text.detail,
    ...(options.icon && !options.icon.isEmpty() ? { icon: options.icon } : {}),
  };

  const { response } =
    options.parentWindow && !options.parentWindow.isDestroyed()
      ? await dialog.showMessageBox(options.parentWindow, dialogOptions)
      : await dialog.showMessageBox(dialogOptions);

  if (response === 0) {
    const url = resolveArchitectureDownloadUrl();
    options.logger.info(`[architecture] user chose to go to the download page: ${url}`);
    await shell.openExternal(url);
  }
}
