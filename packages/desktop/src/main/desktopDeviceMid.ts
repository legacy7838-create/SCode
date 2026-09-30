import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { createUuid } from "@zcode/shared";
import { getAppConfigDir } from "@zcode/services/node";

interface EnsureDesktopDeviceMidSyncOptions {
  /** The directory where the state file is located, defaults to getAppConfigDir() (i.e. ~/.zcode/v2). Test injection only */
  configDir?: string;
  /** UUID generator, default createUuid. Test injection only */
  createId?: () => string;
}

/**
 * Synchronously makes sure the device identity file (still named telemetry-state.json on disk, shared
 * with the CLI / remote server) carries a deviceMid, and returns that value.
 *
 * It shares the `deviceMid` field of that same file with the data-warehouse reporting path
 * (telemetryCore), so the device_mid reported to ARMS and the one reported to the warehouse are the
 * same persistent UUID. The ARMS side needs the value synchronously before the window is created
 * (injected through the preload `--device-id=`), hence the synchronous node:fs reads and writes.
 *
 * Race avoidance:
 * - When a valid deviceMid already exists it is returned directly and nothing is ever written to disk
 *   (zero writes for existing users / second launches).
 * - We write only when it is missing, and we read the *complete* state, add just deviceMid and write
 *   it back, so the fields telemetryCore writes (lastDailyActiveDate / dailyActiveInFlight, ...) are
 *   not clobbered.
 * - The write is atomic (temp file + renameSync), so a concurrent reader can never see half a JSON
 *   document.
 *
 * No fs / JSON exception is ever thrown: if persisting fails we still return the UUID generated in
 * memory and try to persist it again on the next launch, so deviceMid always has a value at the
 * moment the window is created.
 */
export function ensureDesktopDeviceMidSync(options?: EnsureDesktopDeviceMidSyncOptions): string {
  const createId = options?.createId ?? createUuid;
  try {
    const configDir = options?.configDir ?? getAppConfigDir();
    const stateFile = join(configDir, "telemetry-state.json");

    const state = readDeviceStateSync(stateFile);
    if (typeof state.deviceMid === "string" && state.deviceMid) {
      return state.deviceMid;
    }

    const deviceMid = createId();
    state.deviceMid = deviceMid;
    writeDeviceStateSync(stateFile, state);
    return deviceMid;
  } catch {
    // fs/JSON Exception Coverage: Ensure there is a return value and window creation is not blocked
    return createId();
  }
}

function readDeviceStateSync(stateFile: string): Record<string, unknown> {
  try {
    const raw = readFileSync(stateFile, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeDeviceStateSync(stateFile: string, state: Record<string, unknown>): void {
  const dir = dirname(stateFile);
  mkdirSync(dir, { recursive: true });
  const tempFile = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(tempFile, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tempFile, stateFile);
}
