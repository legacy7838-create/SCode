import { app } from "electron";
import { getAppConfigDir } from "@zcode/services/node";

type ElectronAppPathName = "appData" | "userData";

export function isElectronAppPackaged(): boolean {
  return (app as unknown as { isPackaged?: boolean } | undefined)?.isPackaged === true;
}

export function getElectronAppPath(name: ElectronAppPathName): string {
  const electronApp = app as unknown as
    | { getPath?: (pathName: ElectronAppPathName) => string }
    | undefined;
  if (electronApp?.getPath) {
    return electronApp.getPath(name);
  }

  // Part of the main-process single test only mocks the Electron API that is directly needed by the module under test.
  // You may not be able to get the app when importing desktopRuntimeEnv indirectly. The real desktop operation still uses app.getPath;
  // Node-only tests use the configuration directory to avoid interrupting irrelevant tests with constants during the import period.
  return getAppConfigDir();
}
