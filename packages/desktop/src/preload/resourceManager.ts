import { contextBridge, ipcRenderer } from "electron";
import { PlatformChannels, formatZCodeRendererProcessName } from "@zcode/shared";
import type {
  ResourceUsageSnapshot,
  StorageCleanRequest,
  StorageCleanResult,
  StorageManagementBridge,
  StorageUsageSnapshot,
} from "@zcode/shared";

process.title = formatZCodeRendererProcessName("Resource Manager");

const storage: StorageManagementBridge = {
  startScan: (): Promise<{ jobId: string }> =>
    ipcRenderer.invoke(PlatformChannels.StorageStartScan),
  cancelScan: (jobId: string): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.StorageCancelScan, jobId),
  getSnapshot: (): Promise<StorageUsageSnapshot | null> =>
    ipcRenderer.invoke(PlatformChannels.StorageGetSnapshot),
  clean: (request: StorageCleanRequest): Promise<StorageCleanResult> =>
    ipcRenderer.invoke(PlatformChannels.StorageClean, request),
  revealPath: (absolutePath: string): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.StorageRevealPath, absolutePath),
  subscribeScanProgress: (listener) => {
    const handler = (_event: unknown, snapshot: StorageUsageSnapshot) => listener(snapshot);
    ipcRenderer.on(PlatformChannels.StorageScanProgress, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.StorageScanProgress, handler);
  },
};

/**
 * Resource manager window-specific preload - resource snapshot pulling + storage management command surface.
 * MessagePort forwarding is not required because the explorer window does not use the RPC service and does not access the desktop continuous main link;
 * The storage service is held by main, which is just the ipc bridge.
 */
contextBridge.exposeInMainWorld("resourceManager", {
  setSamplingActive: (active: boolean): void =>
    ipcRenderer.send(PlatformChannels.SetResourceUsageSamplingActive, active),
  getSnapshot: (): Promise<ResourceUsageSnapshot> =>
    ipcRenderer.invoke(PlatformChannels.GetResourceUsageSnapshot),
  storage,
});
