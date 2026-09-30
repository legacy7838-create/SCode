import { readFile, rename, writeFile } from "node:fs/promises";
import { serverStatusSchema, type ServerStatus } from "../contracts.js";
import { resolveServerLayout, type ServerLayout } from "./paths.js";

type PersistedStatusRead =
  | { state: "valid"; status: ServerStatus }
  | { state: "missing"; status: null }
  | { state: "invalid" | "unreadable"; status: null; error: unknown };

export async function readPersistedStatusDetailed(
  layout: ServerLayout,
): Promise<PersistedStatusRead> {
  // Missing files indicate offline, and damaged JSON/schema indicates untrustworthy observations; the two cannot be collapsed into the same null.
  // Otherwise, uninstall/stop will misjudge "unable to confirm stopped" as "stopped".
  let raw: string;
  try {
    raw = await readFile(layout.statusFile, "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { state: "missing", status: null };
    }
    return { state: "unreadable", status: null, error };
  }
  try {
    return { state: "valid", status: serverStatusSchema.parse(JSON.parse(raw)) };
  } catch (error: unknown) {
    return { state: "invalid", status: null, error };
  }
}

export async function readPersistedStatus(
  layout = resolveServerLayout(),
): Promise<ServerStatus | null> {
  return (await readPersistedStatusDetailed(layout)).status;
}

export function createStatusPersister<T>(
  statusFile: string,
  getStatus: () => T,
  onError: (error: unknown) => void,
): () => Promise<void> {
  let inFlight: Promise<void> = Promise.resolve();
  return async () => {
    // A status disk writing failure cannot cause the queuing chain to be permanently rejected, otherwise subsequent life cycle snapshots
    // All will be lost; status.json is just an observation snapshot. If it fails, an alarm will be recorded and the service life cycle will continue.
    inFlight = inFlight
      .then(async () => {
        const temporary = `${statusFile}.${process.pid}.tmp`;
        await writeFile(temporary, `${JSON.stringify(getStatus(), null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        await rename(temporary, statusFile);
      })
      .catch((error: unknown) => onError(error));
    await inFlight;
  };
}
