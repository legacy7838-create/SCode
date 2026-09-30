/**
 * Storage scan worker entry point (a `worker_threads` worker inside the main process).
 * Its only job is to run services' `runStorageScan` on a separate thread and post the aggregated
 * snapshot back to the main thread with throttling; all traversal, classification, and aggregation
 * logic comes from @zcode/services (a single scan path).
 */
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type { StorageRootSpec } from "@zcode/services";
import { runStorageScan } from "@zcode/services/node";
import {
  isStorageScanWorkerCommand,
  type StorageScanWorkerData,
  type StorageScanWorkerMessage,
} from "./storageScanWorkerProtocol.js";

const port = parentPort;
if (!isMainThread && port) {
  const data = workerData as StorageScanWorkerData;
  const controller = new AbortController();
  const post = (message: StorageScanWorkerMessage) => port.postMessage(message);
  port.on("message", (message: unknown) => {
    if (isStorageScanWorkerCommand(message) && message.type === "abort") {
      controller.abort();
    }
  });
  void runStorageScan({
    roots: data.roots as StorageRootSpec[],
    signal: controller.signal,
    progressIntervalMs: data.progressIntervalMs,
    onProgress: (progress) => post({ type: "progress", progress }),
  })
    .then((progress) => post({ type: "done", progress }))
    .catch((error: unknown) => {
      const isAbort = error instanceof Error && error.name === "AbortError";
      post({
        type: isAbort ? "aborted" : "error",
        message: error instanceof Error ? error.message : String(error),
        code:
          error && typeof error === "object" && "code" in error && typeof error.code === "string"
            ? error.code
            : undefined,
      });
    });
}
