import type { PrintPageToPdfResult } from "@zcode/shared";
import { PlatformChannels } from "@zcode/shared";
import { ipcMain } from "electron";

/** Serialize print requests for the same webContents to prevent repeated triggering of the Chromium print pipeline */
const inFlightSenderIds = new Set<number>();

export function registerDesktopPrintToPdfIpcHandler(logger: {
  warn: (...args: unknown[]) => void;
}) {
  ipcMain.handle(PlatformChannels.PrintToPdf, async (event): Promise<PrintPageToPdfResult> => {
    const senderId = event.sender.id;
    if (inFlightSenderIds.has(senderId)) {
      return { success: false, error: "print_in_progress" };
    }
    inFlightSenderIds.add(senderId);
    try {
      const buffer = await event.sender.printToPDF({
        printBackground: true,
        // The page size is completely determined by @page CSS injected by renderer. The main side does not accept renderer parameters.
        preferCSSPageSize: true,
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
      });
      // Buffer may be a pooled view, cut out an independent ArrayBuffer and then use structured clone
      const data = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      return { success: true, data };
    } catch (error) {
      logger.warn(
        `[print-to-pdf] export failed error=${error instanceof Error ? error.message : String(error)}`,
      );
      return { success: false, error: "print_failed" };
    } finally {
      inFlightSenderIds.delete(senderId);
    }
  });
}
