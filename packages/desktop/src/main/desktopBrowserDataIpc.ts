import { ipcMain } from "electron";
import { PlatformChannels, type ChromeBrowserDataImportOptions } from "@zcode/shared";
import { clearEmbeddedBrowserData, importChromeBrowserData } from "./browserDataManager.js";

export function registerBrowserDataIpcHandlers(logger: {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}) {
  ipcMain.handle(PlatformChannels.ImportChromeBrowserData, (_event, value: unknown) => {
    const requested = value as ChromeBrowserDataImportOptions | undefined;
    // Renderer can only explicitly pass true for this call; main does not accept or persist other authorization forms.
    const allowElevatedChromeDecryption = requested?.allowElevatedChromeDecryption === true;
    return importChromeBrowserData({ allowElevatedChromeDecryption, logger });
  });
  ipcMain.handle(PlatformChannels.ClearEmbeddedBrowserData, (_event, mode: unknown) => {
    if (mode !== "cache" && mode !== "all") {
      return { success: false, error: "invalid_clear_mode" };
    }
    return clearEmbeddedBrowserData({ logger, mode });
  });
}
