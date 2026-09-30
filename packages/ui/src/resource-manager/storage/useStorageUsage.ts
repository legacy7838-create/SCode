/**
 * useStorageUsage — the data source for the resource manager's “Storage” tab, whose input is the
 * StorageManagementBridge exposed by preload. The lifetime is bound to the tab: it starts scanning
 * and subscribes to progress while enabled, and cancels on unmount / switch-away; a scan is
 * cancelled when the window has been out of focus for more than 60s and starts over once it returns
 * to the foreground (a performance constraint). Only snapshots for the current jobId are consumed
 * and trailing packets from old jobs are dropped outright; on entry it first shows the last
 * completed snapshot (stale-while-revalidate).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  StorageCleanRequest,
  StorageCleanResult,
  StorageManagementBridge,
  StorageUsageSnapshot,
} from "@zcode/shared";
import { logger } from "@/logger.js";

const STORAGE_SCAN_BLUR_CANCEL_MS = 60_000;

interface StorageUsageState {
  snapshot: StorageUsageSnapshot | null;
  scanning: boolean;
  rescan: () => Promise<void>;
  clean: (request: StorageCleanRequest) => Promise<StorageCleanResult>;
}

export function useStorageUsage({
  bridge,
  enabled,
}: {
  bridge: StorageManagementBridge | undefined;
  enabled: boolean;
}): StorageUsageState {
  const [snapshot, setSnapshot] = useState<StorageUsageSnapshot | null>(null);
  const [scanning, setScanning] = useState(false);
  const jobIdRef = useRef<string | null>(null);

  const start = useCallback(async () => {
    if (!bridge) return;
    try {
      const { jobId } = await bridge.startScan();
      jobIdRef.current = jobId;
      setScanning(true);
    } catch (error) {
      logger.warn("[storage] startScan failed", { error });
      setScanning(false);
    }
  }, [bridge]);

  const cancel = useCallback(async () => {
    const jobId = jobIdRef.current;
    jobIdRef.current = null;
    setScanning(false);
    if (!jobId || !bridge) return;
    try {
      await bridge.cancelScan(jobId);
    } catch (error) {
      logger.warn("[storage] cancelScan failed", { error, jobId });
    }
  }, [bridge]);

  useEffect(() => {
    if (!enabled || !bridge) return;
    let disposed = false;
    const unsubscribe = bridge.subscribeScanProgress((next) => {
      if (disposed || next.jobId !== jobIdRef.current) return;
      setSnapshot(next);
      if (next.status !== "scanning") {
        jobIdRef.current = null;
        setScanning(false);
      }
    });
    void bridge
      .getSnapshot()
      .then((previous) => {
        if (!disposed && previous && !jobIdRef.current) setSnapshot(previous);
      })
      .catch(() => {});
    void start();
    return () => {
      disposed = true;
      unsubscribe();
      void cancel();
    };
  }, [enabled, bridge, start, cancel]);

  useEffect(() => {
    if (!enabled || !bridge || typeof window === "undefined") return;
    let blurTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelledByBlur = false;
    const onBlur = () => {
      if (blurTimer) clearTimeout(blurTimer);
      blurTimer = setTimeout(() => {
        blurTimer = null;
        if (!jobIdRef.current) return;
        cancelledByBlur = true;
        void cancel();
      }, STORAGE_SCAN_BLUR_CANCEL_MS);
    };
    const onFocus = () => {
      if (blurTimer) {
        clearTimeout(blurTimer);
        blurTimer = null;
      }
      if (cancelledByBlur) {
        cancelledByBlur = false;
        void start();
      }
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      if (blurTimer) clearTimeout(blurTimer);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, bridge, start, cancel]);

  const clean = useCallback(
    async (request: StorageCleanRequest) => {
      if (!bridge) throw new Error("storage bridge unavailable");
      jobIdRef.current = null;
      setScanning(false);
      const result = await bridge.clean(request);
      await start();
      return result;
    },
    [bridge, start],
  );

  return { snapshot, scanning, rescan: start, clean };
}
