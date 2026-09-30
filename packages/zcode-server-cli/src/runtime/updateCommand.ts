import { updatePreparationResultSchema } from "../contracts.js";
import { requestControl } from "../ipc/controlClient.js";
import { createServiceLogger } from "@zcode/services/node";
import type { ServerLayout } from "./paths.js";
import { prepareOnlineUpdate } from "./updatePreparation.js";

interface UpdateCliIO {
  stdout?: { write(value: string): void };
}

function stdout(io: UpdateCliIO, value: unknown): void {
  io.stdout?.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
}

function isRunningTaskUpdateGuard(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes("Running tasks require --force for update")
  );
}

const log = createServiceLogger("server-update-command");

async function discardPreparedUpdateBestEffort(
  discard: (() => Promise<void>) | undefined,
): Promise<void> {
  if (!discard) return;
  try {
    await discard();
  } catch (error: unknown) {
    // Preparing product cleanup is a non-critical completion; direct await discard will cause the cleanup failure to be overwritten
    // Raw errors in running-task guard or control socket, causing users to see wrong troubleshooting directions.
    log.warn("failed to discard prepared update after command failure", error);
  }
}

export async function runUpdateCommand(
  argv: readonly string[],
  io: UpdateCliIO,
  json: boolean,
  layout: ServerLayout,
  applyUpdate: () => Promise<number>,
): Promise<number> {
  const force = argv.includes("--force");
  let discardPreparedUpdate: (() => Promise<void>) | undefined;
  if (!force) {
    // prepareOnlineUpdate will download, decompress and write pending release; the old process will
    // Only the apply-update check runs the task, causing guard to reject while still leaving network and disk side effects. Check the known ones first
    // Run the task and check again when the preparation is complete; eventually the apply-update guard still covers the last small segment of the race condition.
    const result = updatePreparationResultSchema.parse(
      await requestControl(layout.controlEndpoint, { command: "prepare-update" }),
    );
    if (result.status === "blocked") throw new Error("Running tasks require --force for update");
  }
  const preparation = await prepareOnlineUpdate(layout);
  discardPreparedUpdate = "discard" in preparation ? preparation.discard : undefined;
  if (preparation.status === "up-to-date") {
    if (json) stdout(io, preparation);
    else stdout(io, `ZCode Server ${preparation.version} is already up to date`);
    return 0;
  }
  if (!force && discardPreparedUpdate) {
    const discard = discardPreparedUpdate;
    try {
      const result = updatePreparationResultSchema.parse(
        await requestControl(layout.controlEndpoint, { command: "prepare-update" }),
      );
      if (result.status === "blocked") {
        await discardPreparedUpdateBestEffort(discard);
        discardPreparedUpdate = undefined;
        throw new Error("Running tasks require --force for update");
      }
    } catch (error: unknown) {
      if (isRunningTaskUpdateGuard(error)) throw error;
      await discardPreparedUpdateBestEffort(discard);
      discardPreparedUpdate = undefined;
      throw error;
    }
  }
  try {
    const result = await applyUpdate();
    discardPreparedUpdate = undefined;
    return result;
  } catch (error: unknown) {
    if (isRunningTaskUpdateGuard(error)) {
      await discardPreparedUpdateBestEffort(discardPreparedUpdate);
      discardPreparedUpdate = undefined;
    }
    throw error;
  }
}
