import { spawn } from "node:child_process";
import { resolve } from "node:path";

const MENU_KEY_NAME = "ZCode.OpenInZCode";
const DIRECTORY_MENU_KEY = `HKCU\\Software\\Classes\\Directory\\shell\\${MENU_KEY_NAME}`;
const DRIVE_MENU_KEY = `HKCU\\Software\\Classes\\Drive\\shell\\${MENU_KEY_NAME}`;
const MENU_LABEL = "Open in ZCode";

type Logger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

interface WindowsOpenFolderRegistryOperation {
  args: string[];
}

function quoteWindowsCommandArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function buildWindowsOpenFolderCommand(
  executablePath: string,
  appArgs: readonly string[] = [],
): string {
  return [
    quoteWindowsCommandArg(executablePath),
    ...appArgs.map(quoteWindowsCommandArg),
    "--open-workspace",
    '"%1"',
  ].join(" ");
}

function buildWindowsOpenFolderRegistryOperations(options: {
  executablePath: string;
  appArgs?: readonly string[];
}): WindowsOpenFolderRegistryOperation[] {
  const command = buildWindowsOpenFolderCommand(options.executablePath, options.appArgs ?? []);
  const menuKeys = [DIRECTORY_MENU_KEY, DRIVE_MENU_KEY];

  return menuKeys.flatMap((menuKey) => [
    { args: ["add", menuKey, "/ve", "/d", MENU_LABEL, "/f"] },
    { args: ["add", menuKey, "/v", "MUIVerb", "/t", "REG_SZ", "/d", MENU_LABEL, "/f"] },
    { args: ["add", menuKey, "/v", "Icon", "/t", "REG_SZ", "/d", options.executablePath, "/f"] },
    { args: ["add", `${menuKey}\\command`, "/ve", "/d", command, "/f"] },
  ]);
}

function runRegAdd(args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("reg.exe", [...args], {
      stdio: "ignore",
      windowsHide: true,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      reject(new Error(`reg.exe exited with code ${code ?? "unknown"}`));
    });
  });
}

export async function installWindowsOpenFolderContextMenu(options: {
  platform: NodeJS.Platform;
  executablePath: string;
  argv: readonly string[];
  isDefaultApp: boolean;
  logger: Logger;
}): Promise<void> {
  if (options.platform !== "win32") {
    return;
  }

  const appArgs =
    // The process.execPath of development Windows is the Electron executable file.
    // The registry command must also bring an application entry, otherwise the Explorer right-click menu can only launch empty Electron.
    options.isDefaultApp && options.argv[1] ? [resolve(options.argv[1])] : [];
  const operations = buildWindowsOpenFolderRegistryOperations({
    executablePath: options.executablePath,
    appArgs,
  });

  try {
    await Promise.all(operations.map((operation) => runRegAdd(operation.args)));

    options.logger.info(
      "[open-folder] the Windows Explorer context menu was installed or updated",
      {
        executablePath: options.executablePath,
        hasDefaultAppEntry: appArgs.length > 0,
      },
    );
  } catch (error) {
    options.logger.warn("[open-folder] failed to install the Windows Explorer context menu", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
