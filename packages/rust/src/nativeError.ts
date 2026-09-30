/**
 * Decodes the native crates' structured error envelope back into a real `Error`.
 *
 * Both `zcode-events` and `zcode-task-index` reject with a JSON message
 * (`{"z":1,"m":…,"k":…,"c":…,"i":…,"d":…,"sm":…}`) rather than a plain string, because
 * `@zcode/shared`'s `classifyDatabaseStartupError` / `databaseStartupErrorDetails` read
 * `error.kind` / `error.errcode` / `error.migrationId` and **not** the message. Rebuilding the
 * properties is what keeps the legacy classification working with the native store — a plain
 * message would silently collapse every native failure to `sql_failed`.
 *
 * There is no JavaScript fallback here: a non-envelope message is returned untouched.
 */

/** The envelope keys. `sm` is the task-index startup migration facts. */
interface NativeErrorEnvelope {
  z?: number;
  m?: string;
  k?: string;
  c?: number;
  i?: string;
  d?: string;
  sm?: unknown;
}

/**
 * Rebuilds a readable `Error` carrying the envelope's `kind`/`errcode`/`migrationId`/`dbPath`
 * properties; the raw native error stays as `cause`. Returns the input unchanged when it is not
 * an envelope.
 */
export function fromNativeError(error: unknown): Error {
  if (error instanceof Error) {
    try {
      const parsed = JSON.parse(error.message) as NativeErrorEnvelope;
      if (parsed && parsed.z === 1 && typeof parsed.m === "string") {
        const rebuilt = new Error(parsed.m, { cause: error });
        if (typeof parsed.k === "string") Object.assign(rebuilt, { kind: parsed.k });
        if (typeof parsed.c === "number") Object.assign(rebuilt, { errcode: parsed.c });
        if (typeof parsed.i === "string") Object.assign(rebuilt, { migrationId: parsed.i });
        if (typeof parsed.d === "string") Object.assign(rebuilt, { dbPath: parsed.d });
        if (parsed.sm !== undefined) Object.assign(rebuilt, { startupMigration: parsed.sm });
        return rebuilt;
      }
    } catch {
      // Not an envelope (a plain JS Error, e.g. the loader's missing-binary error) — leave it.
    }
    return error;
  }
  return new Error(String(error));
}
