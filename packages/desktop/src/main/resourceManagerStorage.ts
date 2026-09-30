/**
 * Main-side wiring for the resource manager's "Storage" tab: main holds the single StorageService
 * instance (the traversal runs on a Worker thread), exposes its command surface through ipc
 * invoke, and pushes progress snapshots to the resource manager window that issued the request;
 * closing the window cancels the scan.
 * It lives in main rather than in a Window Host because that window is designed not to take RPC
 * (see preload/resourceManager.ts), and the disk scan is just an fs traversal, which runs inside
 * worker_threads without blocking the main event loop.
 */
import { BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from "electron";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { PlatformChannels, type StorageCleanRequest, type StorageRootSpec } from "@zcode/shared";
import {
  createFsStorageCleaner,
  createStorageRootsResolver,
  createStorageService,
  getDataBaseDir,
  type IStorageService,
} from "@zcode/services/node";
import { logger } from "./logger.js";
import { createStorageScanWorkerRunner } from "./storageScanWorkerClient.js";

let service: IStorageService | null = null;
let latestJobId: string | null = null;
let subscriber: WebContents | null = null;
const rootsResolver = createStorageRootsResolver({ getHomeDir: homedir, getDataBaseDir });

function getService(): IStorageService {
  if (service) return service;
  service = createStorageService({
    roots: rootsResolver,
    scanRunner: createStorageScanWorkerRunner(),
    cleaner: createFsStorageCleaner(),
  });
  service.onScanProgress((snapshot) => {
    if (subscriber && !subscriber.isDestroyed()) {
      subscriber.send(PlatformChannels.StorageScanProgress, snapshot);
    }
  });
  return service;
}

/** Only the resource manager window can initiate storage commands; ongoing scans are canceled when the window is closed to avoid idling in the background. */
function bindSubscriber(event: IpcMainInvokeEvent): void {
  if (subscriber === event.sender) return;
  subscriber = event.sender;
  const win = BrowserWindow.fromWebContents(event.sender);
  win?.once("closed", () => {
    if (subscriber !== event.sender) return;
    subscriber = null;
    if (latestJobId && service) {
      void service.cancelScan(latestJobId);
      latestJobId = null;
    }
  });
}

/** Pure function: The location path must fall within a certain data root to prevent the renderer from passing any path to be opened by the system file manager. */
function isPathInsideStorageRoots(absolutePath: string, roots: StorageRootSpec[]): boolean {
  const target = resolve(absolutePath);
  return roots.some((root) => {
    const back = relative(resolve(root.path), target);
    return back === "" || (!back.startsWith("..") && !isAbsolute(back));
  });
}

export function registerResourceManagerStorageIpc(): void {
  ipcMain.handle(PlatformChannels.StorageStartScan, async (event) => {
    bindSubscriber(event);
    const result = await getService().startScan();
    latestJobId = result.jobId;
    return result;
  });
  ipcMain.handle(PlatformChannels.StorageCancelScan, async (_event, jobId: string) => {
    if (!service) return;
    await service.cancelScan(jobId);
    if (latestJobId === jobId) latestJobId = null;
  });
  ipcMain.handle(PlatformChannels.StorageGetSnapshot, async () =>
    service ? service.getSnapshot() : null,
  );
  ipcMain.handle(PlatformChannels.StorageClean, async (event, request: StorageCleanRequest) => {
    bindSubscriber(event);
    return getService().clean(request);
  });
  ipcMain.handle(PlatformChannels.StorageRevealPath, async (_event, absolutePath: string) => {
    const roots = await rootsResolver.resolveRoots();
    if (typeof absolutePath !== "string" || !isPathInsideStorageRoots(absolutePath, roots)) {
      logger.warn("[resource-manager] refused to reveal path outside storage roots", {
        absolutePath,
      });
      return;
    }
    shell.showItemInFolder(absolutePath);
  });
}
