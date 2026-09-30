import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createEncodedPowerShellArgs } from "../../scripts/powershell-command.mjs";

const SYSTEM_CREDENTIAL_TIMEOUT_MS = 15_000;
// macOS `security` will compress OSStatus into an 8-bit process exit code:
// errSecInteractionNotAllowed(-25308) -> 36, errSecAuthFailed(-25293) -> 51,
// errSecUserCanceled(-128) -> 128. All three indicate that this user authorization has not been completed.
const MAC_KEYCHAIN_ACCESS_DENIED_EXIT_CODES = new Set([36, 51, 128]);

export type MacChromeSafeStorageSecretReader = () => Promise<string>;

export class ChromeCookieAccessDeniedError extends Error {
  readonly code = "chrome_cookie_access_denied";

  constructor() {
    super("chrome_cookie_access_denied");
    this.name = "ChromeCookieAccessDeniedError";
  }
}

function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        // The system credential authorization window may be blocked or unattended and cannot permanently block the import process.
        timeout: SYSTEM_CREDENTIAL_TIMEOUT_MS,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

function isMacKeychainAccessDenied(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = error.code;
  return typeof code === "number" && MAC_KEYCHAIN_ACCESS_DENIED_EXIT_CODES.has(code);
}

export async function readMacChromeSafeStorageSecret(
  secretReader: MacChromeSafeStorageSecretReader = () =>
    execFileText("security", ["find-generic-password", "-w", "-s", "Chrome Safe Storage"]),
): Promise<string> {
  try {
    // Secrets are only consumed in main memory and must not enter logs or IPC.
    return await secretReader();
  } catch (error) {
    // User rejection/cancellation of keychain authorization is a termination signal for the entire import and cannot be treated as an ordinary single entry.
    // Cookie decryption fails and is swallowed, otherwise the upper layer will continue to write to LocalStorage, violating the user's explicit choice.
    if (isMacKeychainAccessDenied(error)) throw new ChromeCookieAccessDeniedError();
    throw error;
  }
}

export async function readWindowsChromeMasterKey(userDataDir: string): Promise<Buffer> {
  const localState = JSON.parse(await readFile(join(userDataDir, "Local State"), "utf8")) as {
    os_crypt?: { encrypted_key?: string };
  };
  const encryptedKey = localState.os_crypt?.encrypted_key;
  if (!encryptedKey) throw new Error("chrome_master_key_missing");
  const script = [
    "Add-Type -AssemblyName System.Security;",
    "$data=[Convert]::FromBase64String($zcodeArg0);",
    "if ([Text.Encoding]::ASCII.GetString($data,0,5) -eq 'DPAPI') {$data=$data[5..($data.Length-1)]};",
    "$plain=[Security.Cryptography.ProtectedData]::Unprotect($data,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);",
    "[Convert]::ToBase64String($plain)",
  ].join("");
  // Ordinary `-Command` will not inject the trailing encryptedKey into `$args`, and Windows import will get empty parameters.
  // Use unified EncodedCommand to pass values ​​to avoid secondary parsing of the command line and preserve DPAPI ciphertext boundaries.
  const output = await execFileText(
    "powershell.exe",
    createEncodedPowerShellArgs(script, [encryptedKey]),
  );
  return Buffer.from(output, "base64");
}
