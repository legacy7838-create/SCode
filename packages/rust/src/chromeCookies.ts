/**
 * `@zcode/rust/chrome-cookies` — the last `node:sqlite` user in the repository.
 *
 * `packages/desktop/src/main/chromeCookieManager.ts` used `node:sqlite` for two
 * things: SQLite's Online Backup API (to snapshot Chrome's own Cookies database
 * so the importer never reads a database Chrome may be writing to) and a read of
 * `meta.version` + the `cookies` table. Both live in the `zcode-chrome-cookies`
 * crate now (spec §14.6).
 *
 * INVARIANT: there is NO JavaScript fallback. `loadChromeCookies()` goes through
 * `loadNative`, which hard-throws when the binary is missing.
 *
 * ## Value transport
 *
 * Two column shapes decide the encoding (see the crate docs for the full
 * argument):
 *
 * - `encrypted_value` is a **BLOB** and crosses as **base64** inside the JSON
 *   string; `decodeCookieRows` rebuilds the real `Uint8Array` that
 *   `ChromeCookieRow` declares. Umbrella invariant 8 forbids handing a
 *   `Vec<u8>` to napi as an array, and base64-in-JSON keeps this call a single
 *   string crossing instead of a second boundary.
 * - `expires_utc` / `is_secure` / `is_httponly` / `samesite` are **64-bit
 *   integers** (Chrome's 1601 epoch is ≈1.3e16, past `Number.MAX_SAFE_INTEGER`),
 *   and `node:sqlite` returned them as `BigInt` via `setReadBigInts(true)`. They
 *   cross as **decimal strings** and are rebuilt as real `BigInt`s, because a
 *   JSON number would silently round them.
 */
import { loadNative } from "./loader.js";

/** The `cookies` table as Chrome writes it. Mirrors `ChromeCookieRow` in the desktop package. */
export interface NativeChromeCookieRow {
  host_key: string;
  name: string;
  path: string;
  /** Decimal string; see the module docs. */
  expires_utc: string | null;
  is_secure: string | null;
  is_httponly: string | null;
  samesite: string | null;
  value: string;
  /** base64 of the BLOB; see the module docs. */
  encrypted_value: string | null;
}

export interface NativeChromeCookieSnapshot {
  schemaVersion: number;
  rows: NativeChromeCookieRow[];
}

export interface NativeChromeCookieModule {
  /** Online Backup of `sourcePath` into `destPath`; resolves the page count. */
  backupChromeCookieDb(sourcePath: string, destPath: string): Promise<number>;
  readChromeCookies(databasePath: string): string;
}

function loadChromeCookies(): NativeChromeCookieModule {
  return loadNative<NativeChromeCookieModule>("zcode-chrome-cookies");
}

const BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Decodes the base64 BLOB column to the `Uint8Array` the row type declares.
 *
 * Hand-rolled rather than `Buffer.from(text, "base64")` on purpose: this module
 * is imported by the Electron **main** process, which is bundled, and the raw
 * decoder keeps the byte-boundary behaviour identical on every platform without
 * pulling Node's buffer allocation into the boundary path. `Buffer` is used by
 * the callers anyway (`chromeCookieManager.ts` does `Buffer.from(...)` for the
 * `v10`/`v11`/`v20` prefix check), so this only has to be correct, not fast.
 */
function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, "");
  const bytes = new Uint8Array((clean.length * 3) >> 2);
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (let index = 0; index < clean.length; index += 1) {
    const value = BASE64.indexOf(clean.charAt(index));
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset] = (buffer >> bits) & 0xff;
      offset += 1;
    }
  }
  return offset === bytes.length ? bytes : bytes.subarray(0, offset);
}

/** NULL → `0n`, the value `node:sqlite`'s `setReadBigInts` could not have produced. */
function toBigIntOrZero(text: string | null): bigint {
  if (text === null || text === "") return 0n;
  return BigInt(text);
}

/** A row in the exact shape `chromeCookieMapping.ts` consumes. */
export interface ChromeCookieSnapshotRow {
  host_key: string;
  name: string;
  path: string;
  expires_utc: bigint;
  is_secure: bigint;
  is_httponly: bigint;
  samesite: bigint;
  value: string;
  encrypted_value: Uint8Array;
}

/**
 * Copies `sourcePath` to `destPath` with SQLite's Online Backup API.
 *
 * The exported type is what `chromeCookieManager.ts` calls its injectable
 * `ChromeCookieDatabaseBackup`: `(sourcePath, snapshotPath) => Promise<number>`.
 * Note this is a **path** pair, not a `(DatabaseSync, path)` pair like
 * `node:sqlite`'s `backup` — the native side owns the connection, so the caller
 * never has to open (or leak) a handle it would only pass straight through.
 */
export async function backupChromeCookieDatabase(
  sourcePath: string,
  destPath: string,
): Promise<number> {
  return loadChromeCookies().backupChromeCookieDb(sourcePath, destPath);
}

/** Reads `meta.version` and the `cookies` table of a snapshot. */
export function readChromeCookieSnapshot(
  databasePath: string,
): { rows: ChromeCookieSnapshotRow[]; schemaVersion: number } {
  const snapshot = JSON.parse(
    loadChromeCookies().readChromeCookies(databasePath),
  ) as NativeChromeCookieSnapshot;
  return {
    schemaVersion: Number(snapshot.schemaVersion ?? 0),
    rows: (snapshot.rows ?? []).map((row) => ({
      host_key: row.host_key,
      name: row.name,
      path: row.path,
      expires_utc: toBigIntOrZero(row.expires_utc),
      is_secure: toBigIntOrZero(row.is_secure),
      is_httponly: toBigIntOrZero(row.is_httponly),
      samesite: toBigIntOrZero(row.samesite),
      value: row.value,
      encrypted_value: row.encrypted_value ? decodeBase64(row.encrypted_value) : new Uint8Array(0),
    })),
  };
}
