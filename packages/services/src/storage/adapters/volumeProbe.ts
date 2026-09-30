/**
 * Volume probe: identifies a physical volume via stat().dev, walks upward to find the mount point,
 * then uses statfs to read its capacity.
 * Any step that fails returns null (the UI only shows usage, never capacity) instead of throwing.
 */
import { stat, statfs } from "node:fs/promises";
import { dirname } from "node:path";
import type { StorageVolume } from "@zcode/shared";
import type { VolumeProbePort } from "../app/ports.js";

async function probeStorageVolume(path: string): Promise<StorageVolume | null> {
  try {
    const deviceId = (await stat(path)).dev;
    let mountPoint = path;
    // Go up level by level: continue while the parent directory is still on the same dev; reaching the root or a dev change is the mount point (Windows stops at the drive letter root).
    for (;;) {
      const parent = dirname(mountPoint);
      if (parent === mountPoint) break;
      let parentDev: number | bigint;
      try {
        parentDev = (await stat(parent)).dev;
      } catch {
        break;
      }
      if (parentDev !== deviceId) break;
      mountPoint = parent;
    }
    const fs = await statfs(mountPoint);
    return {
      deviceId: String(deviceId),
      mountPoint,
      totalBytes: Number(fs.blocks) * Number(fs.bsize),
      freeBytes: Number(fs.bavail) * Number(fs.bsize),
    };
  } catch {
    return null;
  }
}

export function createFsVolumeProbe(): VolumeProbePort {
  return { probe: probeStorageVolume };
}
