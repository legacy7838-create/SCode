import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { installLinuxAppImageDesktopIconBestEffort } from "./desktopLinuxAppImageIcon.js";
import {
  runXdgCommand,
  XDG_COMMAND_TIMEOUT_MS,
  type LinuxDesktopCommandRunner,
  type LinuxDeepLinkRegistrationLogger,
} from "./desktopLinuxXdg.js";

const LINUX_DEEP_LINK_DESKTOP_FILE = "zcode.desktop";
const LINUX_DEEP_LINK_MIME_TYPE = "x-scheme-handler/zcode";
// Attribution tag: Used to identify whether user-level zcode.desktop is written by this application (all historical versions have this line of Comment).
const LINUX_DESKTOP_ENTRY_OWNERSHIP_MARKER = "Comment=ZCode Desktop App";

type LinuxDesktopEnv = {
  APPIMAGE?: string;
  XDG_DATA_HOME?: string;
  XDG_DATA_DIRS?: string;
};

interface RegisterLinuxDeepLinkProtocolOptions {
  executablePath: string;
  homeDir: string;
  productName?: string;
  iconSourcePath?: string;
  env?: LinuxDesktopEnv;
  argv?: string[];
  logger: LinuxDeepLinkRegistrationLogger;
  runCommand?: LinuxDesktopCommandRunner;
  systemApplicationDirs?: string[];
}

interface LinuxDeepLinkCommand {
  executablePath: string;
  args: string[];
}

const APPIMAGE_DEEP_LINK_ARG_NAMES = new Set([
  "--no-sandbox",
  "--disable-gpu",
  "--disable-software-rasterizer",
]);

const APPIMAGE_DEEP_LINK_ARG_PREFIXES = [
  "--use-gl=",
  "--use-angle=",
  "--disable-features=",
  "--enable-features=",
];

function resolveLinuxDeepLinkCommand(params: {
  env?: { APPIMAGE?: string };
  executablePath: string;
  argv?: string[];
}): LinuxDeepLinkCommand {
  const appImagePath = params.env?.APPIMAGE?.trim();
  if (!appImagePath) {
    return { executablePath: params.executablePath, args: [] };
  }

  return {
    executablePath: appImagePath,
    // AppImage's zcode:// callback will be started a second time by xdg-open pressing .desktop Exec.
    // The sandbox/GPU parameters attached when the user starts manually will not be automatically inherited, and the secondary startup may crash before Electron is initialized.
    // Only the allowlist parameters that affect the success or failure of startup are persisted here to avoid hard-coding the deep link URL, debugging port or workspace path.
    args: resolveAppImageDeepLinkArgs(params.argv ?? []),
  };
}

function quoteDesktopExecPath(value: string): string {
  return `"${value.replace(/[\\"`$]/g, (match) => `\\${match}`)}"`;
}

function isAllowedAppImageDeepLinkArg(arg: string): boolean {
  return (
    APPIMAGE_DEEP_LINK_ARG_NAMES.has(arg) ||
    APPIMAGE_DEEP_LINK_ARG_PREFIXES.some((prefix) => arg.startsWith(prefix))
  );
}

function resolveAppImageDeepLinkArgs(argv: string[]): string[] {
  const args: string[] = [];
  const seen = new Set<string>();
  for (const arg of argv) {
    if (!isAllowedAppImageDeepLinkArg(arg) || seen.has(arg)) {
      continue;
    }
    seen.add(arg);
    args.push(arg);
  }
  return args;
}

function quoteDesktopExecToken(value: string): string {
  return quoteDesktopExecPath(value);
}

function formatDesktopExec(command: LinuxDeepLinkCommand): string {
  return [command.executablePath, ...command.args]
    .map(quoteDesktopExecToken)
    .concat("%U")
    .join(" ");
}

function createLinuxDeepLinkDesktopEntry(params: {
  executablePath: string;
  args?: string[];
  productName?: string;
  iconName?: string;
}): string {
  const productName = params.productName ?? "ZCode";
  const iconName = params.iconName ?? "zcode";
  const command = {
    executablePath: params.executablePath,
    args: params.args ?? [],
  };
  return [
    "[Desktop Entry]",
    `Name=${productName}`,
    LINUX_DESKTOP_ENTRY_OWNERSHIP_MARKER,
    `Exec=${formatDesktopExec(command)}`,
    "Terminal=false",
    "Type=Application",
    `Icon=${iconName}`,
    "Categories=Development;",
    `MimeType=${LINUX_DEEP_LINK_MIME_TYPE};`,
    `StartupWMClass=${productName}`,
    "",
  ].join("\n");
}

function resolveLinuxUserDataDir(params: {
  env?: { XDG_DATA_HOME?: string };
  homeDir: string;
}): string {
  const xdgDataHome = params.env?.XDG_DATA_HOME?.trim();
  return xdgDataHome || join(params.homeDir, ".local", "share");
}

function resolveLinuxSystemApplicationDirs(env?: { XDG_DATA_DIRS?: string }): string[] {
  const raw = env?.XDG_DATA_DIRS?.trim();
  const entries = raw
    ? raw
        .split(":")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
  // The XDG specification default value is /usr/local/share:/usr/share; all empty XDG_DATA_DIRS also falls back to the default value.
  const dataDirs = entries.length > 0 ? entries : ["/usr/local/share", "/usr/share"];
  return dataDirs.map((dir) => join(dir, "applications"));
}

function findSystemLevelDesktopEntryPath(systemApplicationDirs: string[]): string | undefined {
  for (const dir of systemApplicationDirs) {
    const candidate = join(dir, LINUX_DEEP_LINK_DESKTOP_FILE);
    // Boundaries: Directories or corrupted paths should not be treated as valid system-level entries, otherwise pure AppImage users
    // User-level registrations of are falsely suppressed by pathological paths. Only ordinary files participate in masking judgment.
    try {
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // The path does not exist or cannot be stat (authorized), skip the candidate directory.
    }
  }
  return undefined;
}

function isOwnedDesktopEntry(path: string): boolean {
  try {
    const content = readFileSync(path, "utf8");
    // Remove \r and whitespace at the beginning and end of the line, compatible with CRLF line endings or extra whitespace introduced by manual editors.
    // This prevents cleanable legacy entries from being misjudged as user-defined entries and remaining permanently.
    return content
      .split("\n")
      .some((line) => line.replaceAll("\r", "").trim() === LINUX_DESKTOP_ENTRY_OWNERSHIP_MARKER);
  } catch {
    return false;
  }
}

function removeOwnedUserDesktopEntry(
  desktopFilePath: string,
  logger: LinuxDeepLinkRegistrationLogger,
): void {
  if (!existsSync(desktopFilePath)) {
    return;
  }
  if (!isOwnedDesktopEntry(desktopFilePath)) {
    logger.warn(
      "[deep-link] the Linux user-level zcode.desktop was not written by this app, keeping it",
      {
        desktopFilePath,
      },
    );
    return;
  }
  try {
    rmSync(desktopFilePath);
    logger.info(
      "[deep-link] removed the leftover user-level zcode.desktop, restored the system-level entry",
      {
        desktopFilePath,
      },
    );
  } catch (error) {
    logger.warn("[deep-link] failed to remove the leftover user-level zcode.desktop", {
      desktopFilePath,
      error,
    });
  }
}

function resolveLinuxDeepLinkDesktopFilePath(dataDir: string): string {
  return join(dataDir, "applications", LINUX_DEEP_LINK_DESKTOP_FILE);
}

function writeFileIfChanged(path: string, content: string): boolean {
  if (existsSync(path) && readFileSync(path, "utf8") === content) {
    return false;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return true;
}

export function registerLinuxDeepLinkProtocol(options: RegisterLinuxDeepLinkProtocolOptions): void {
  const command = resolveLinuxDeepLinkCommand({
    env: options.env,
    executablePath: options.executablePath,
    argv: options.argv,
  });
  const dataDir = resolveLinuxUserDataDir({ env: options.env, homeDir: options.homeDir });
  const desktopFilePath = resolveLinuxDeepLinkDesktopFilePath(dataDir);
  const applicationsDir = dirname(desktopFilePath);
  const desktopEntry = createLinuxDeepLinkDesktopEntry({
    ...command,
    productName: options.productName,
  });
  let protocolRegistered = false;
  const runCommand = options.runCommand ?? runXdgCommand;

  // User level zcode.desktop in XDG
  // Always takes precedence over system-level entries with the same name in parsing. After rpm/deb installation, user-level entries written by the old AppImage will
  // /usr/share/applications/zcode.desktop remains obscured, shortcuts and zcode:// deep links remain
  // Point to the old AppImage (when the file is still there) or directly invalid (after the file is deleted). It will only be overwritten by manually running a new version.
  // Now whenever a system level entry with the same ID is detected:
  // - When running in system installation mode (rpm/deb): clear the legacy user-level entries written by this application, and no longer write user-level entries;
  // - AppImage runtime: no longer write user-level entries and user-level icons to prevent old AppImages from blocking system installation again.
  // User-written custom zcode.desktop (without attribution tag) is not affected and is retained without cleaning.
  const systemDesktopEntryPath = findSystemLevelDesktopEntryPath(
    options.systemApplicationDirs ?? resolveLinuxSystemApplicationDirs(options.env),
  );

  try {
    let changed = false;
    if (systemDesktopEntryPath) {
      options.logger.info("[deep-link] the Linux system-level desktop entry already exists", {
        systemDesktopEntryPath,
        desktopFilePath,
      });
      removeOwnedUserDesktopEntry(desktopFilePath, options.logger);
    } else {
      changed = writeFileIfChanged(desktopFilePath, desktopEntry);
    }
    // AppImage direct running will not be written to the system desktop entry as stably as the deb installation package.
    // The deep link is the core link opened by OAuth/payment/workspace, and the user-level protocol processor refresh must be completed first;
    // Icon installation is an optional enhancement and can be downgraded independently after successful core registration to avoid expanding the login callback failure domain.
    const updateResult = runCommand("update-desktop-database", [applicationsDir]);
    const defaultResult = runCommand("xdg-mime", [
      "default",
      LINUX_DEEP_LINK_DESKTOP_FILE,
      LINUX_DEEP_LINK_MIME_TYPE,
    ]);

    if (defaultResult.status === 0) {
      protocolRegistered = true;
      options.logger.info("[deep-link] Linux user-level protocol registration succeeded", {
        desktopFilePath,
        executablePath: command.executablePath,
        args: command.args,
        changed,
        systemDesktopEntryPath,
      });
    } else {
      options.logger.warn("[deep-link] Linux user-level protocol registration failed", {
        desktopFilePath,
        executablePath: command.executablePath,
        args: command.args,
        status: defaultResult.status,
        signal: defaultResult.signal,
        timeoutMs: defaultResult.signal === "SIGTERM" ? XDG_COMMAND_TIMEOUT_MS : undefined,
        error: defaultResult.error?.message,
        stderr: defaultResult.stderr?.trim(),
      });
    }

    if (updateResult.error) {
      options.logger.warn("[deep-link] update-desktop-database is unavailable, skipped", {
        desktopFilePath,
        message: updateResult.error.message,
      });
    } else if (updateResult.signal === "SIGTERM") {
      options.logger.warn("[deep-link] update-desktop-database timed out, skipped", {
        desktopFilePath,
        timeoutMs: XDG_COMMAND_TIMEOUT_MS,
      });
    } else if (updateResult.status !== 0) {
      options.logger.warn("[deep-link] update-desktop-database failed, skipped", {
        desktopFilePath,
        status: updateResult.status,
        signal: updateResult.signal,
        stderr: updateResult.stderr?.trim(),
      });
    }
  } catch (error) {
    options.logger.warn(
      "[deep-link] unexpected error during Linux user-level protocol registration",
      {
        desktopFilePath,
        executablePath: command.executablePath,
        args: command.args,
        error,
      },
    );
  }

  const iconInstallResult = systemDesktopEntryPath
    ? null
    : installLinuxAppImageDesktopIconBestEffort({
        dataDir,
        env: options.env,
        iconSourcePath: options.iconSourcePath,
        logger: options.logger,
        runCommand,
      });
  if (iconInstallResult) {
    options.logger.info("[deep-link] Linux AppImage user-level icon installation completed", {
      protocolRegistered,
      iconFilePath: iconInstallResult.iconFilePath,
      iconInstalled: iconInstallResult.installed,
      iconChanged: iconInstallResult.changed,
    });
  }
}
