import { ensureDeviceMid as ensureSharedDeviceMid } from "@zcode/services/node";

interface EnsureRemoteServerDeviceMidOptions {
  /** For test injection only; production always uses services' ensureDeviceMid. */
  ensureDeviceMid?: () => Promise<string>;
  log: (...args: unknown[]) => void;
}

/**
 * Makes sure the host the remote server runs on has its own deviceMid at startup.
 *
 * A remote workspace (SSH/WSL) has no Desktop main process, and historically nothing wrote the
 * device identity file on the remote host, while buildZCodeSourceHeaders() only reads and never
 * generates it. Since 3.12.0 the remote side queries Start Plan entitlements itself, so
 * billing/balance requests were rejected by the server as a parameter error for the missing
 * X-Device-Mid header, and remote workspaces could not see Start Plan models. Desktop main
 * carries this responsibility locally through ensureDesktopDeviceMidSync; here the remote stdio
 * entry point carries the same responsibility, reusing the same file, field, and lock so that it
 * shares one device identity with a co-located zcode-cli.
 *
 * Failure does not block startup: a missing device identifier only means ZCode endpoint requests
 * go out with one header fewer (exactly the behavior before the fix), and nothing else in the
 * remote server depends on it; we log a warning and keep the cause, never fabricating a device
 * ID.
 */
export async function ensureRemoteServerDeviceMid(
  options: EnsureRemoteServerDeviceMidOptions,
): Promise<string | undefined> {
  const ensureDeviceMid = options.ensureDeviceMid ?? ensureSharedDeviceMid;
  try {
    return await ensureDeviceMid();
  } catch (error) {
    options.log(
      "deviceMid initialization failed, ZCode endpoint requests will be sent without X-Device-Mid:",
      error instanceof Error ? error.message : String(error),
    );
    return undefined;
  }
}
