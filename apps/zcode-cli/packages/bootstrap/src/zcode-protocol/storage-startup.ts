import { createHash, randomUUID } from "node:crypto";
import { SqliteSessionStore, type SqliteMigrationProgress } from "@zcode/adapters/storage";
import {
  classifyDatabaseStartupError,
  databaseStartupErrorDetails,
  zcodeProtocolNotifications,
  zcodeStorageStartupStateSchema,
  type ZCodeStorageStartupState,
} from "@zcode/shared";

export async function openProtocolStartupStorage(options: {
  dbPath: string;
  output: NodeJS.WritableStream;
  onProgress?: (progress: ZCodeStorageStartupState) => void;
}): Promise<SqliteSessionStore> {
  const attemptId = randomUUID();
  const databaseId = createHash("sha256").update(options.dbPath).digest("hex");
  let sequence = 0;
  let failedReported = false;
  const report = async (progress: SqliteMigrationProgress) => {
    const params = zcodeStorageStartupStateSchema.parse({
      schemaVersion: 1,
      attemptId,
      databaseId,
      databaseKind: "session",
      sequence: ++sequence,
      ...progress,
    });
    failedReported ||= params.phase === "failed";
    options.onProgress?.(params);
    // You cannot first write to the JS buffer and then immediately block the execution of SQL; wait for Writable to confirm that the control frame has been handed over to the transport layer.
    await new Promise<void>((resolve, reject) => {
      options.output.write(
        `${JSON.stringify({ method: zcodeProtocolNotifications.storageStartup, params })}\n`,
        (error?: Error | null) => (error ? reject(error) : resolve()),
      );
    });
  };
  try {
    await report({ phase: "checking", elapsedMs: 0 });
    return await SqliteSessionStore.openStartup({ dbPath: options.dbPath }, { onProgress: report });
  } catch (error) {
    if (!failedReported) {
      try {
        await report({
          phase: "failed",
          elapsedMs: 0,
          errorCode: classifyDatabaseStartupError(error),
          ...databaseStartupErrorDetails(error),
        });
      } catch {
        /* Keep the original database/transport error when the transport has already disconnected. */
      }
    }
    throw error;
  }
}

/** Prepare storage only; do not create the Provider/MCP/workspace runtime; writes to the database are allowed only after the Host confirms the observation boundary. */
export async function prepareProtocolStartupStorage(options: {
  dbPath: string;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}): Promise<void> {
  const { createInterface } = await import("node:readline");
  const { zcodeStoragePathReadySchema, classifyDatabaseStartupError } =
    await import("@zcode/shared");
  const lines = createInterface({ input: options.input });
  let timer: ReturnType<typeof setTimeout>;
  const acknowledgement = new Promise<boolean>((resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          Object.assign(new Error("Storage observation handshake timed out"), {
            kind: "startup_status_timeout",
          }),
        ),
      30_000,
    );
    lines.once("line", (line) => {
      try {
        if (line.length > 1024) throw new Error("Invalid storage acknowledgement");
        const ack = zcodeStoragePathReadySchema.parse(JSON.parse(line));
        resolve(ack.reuse ?? false);
      } catch (error) {
        reject(error);
      }
    });
    lines.once("close", () =>
      reject(
        Object.assign(new Error("Storage preparation input closed"), { kind: "transport_closed" }),
      ),
    );
  });
  // When the path notification fails to be sent, the created waiting promise must also be consumed to avoid unhandled rejection.
  void acknowledgement.catch(() => {});
  let store: SqliteSessionStore | undefined;
  let failure: unknown;
  const write = (frame: unknown) =>
    new Promise<void>((resolve, reject) => {
      options.output.write(`${JSON.stringify(frame)}\n`, (error?: Error | null) =>
        error ? reject(error) : resolve(),
      );
    });
  try {
    await write({ method: "startup/storagePath", params: { path: options.dbPath } });
    const reuse = await acknowledgement;
    clearTimeout(timer!);
    lines.close();
    // reuse is only granted by a successful set of paths prepared by the same Host; no connection is opened, and no permanent skip flag is written.
    if (!reuse) {
      store = await openProtocolStartupStorage(options);
      store.close();
      store = undefined;
    }
    await write({ method: "startup/storagePrepared", params: {} });
  } catch (error) {
    failure = error;
    try {
      await write({
        method: "startup/storageState",
        params: {
          schemaVersion: 1,
          attemptId: randomUUID(),
          databaseId: createHash("sha256").update(options.dbPath).digest("hex"),
          databaseKind: "session",
          sequence: 1,
          phase: "failed",
          elapsedMs: 0,
          errorCode: classifyDatabaseStartupError(error),
          ...databaseStartupErrorDetails(error),
        },
      });
    } catch {
      /* The original storage error takes precedence over the IO error of the failure notification. */
    }
    throw error;
  } finally {
    clearTimeout(timer!);
    lines.close();
    try {
      store?.close();
    } catch (error) {
      if (!failure) throw error;
    }
  }
}
