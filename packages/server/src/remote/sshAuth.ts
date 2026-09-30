import type { ConnectConfig } from "ssh2";

export const SSH_READY_TIMEOUT_MS = 60_000;
export const SSH_KEEPALIVE_INTERVAL_MS = 15_000;
export const SSH_KEEPALIVE_COUNT_MAX = 3;

interface SSHConnectConfigInput {
  host: string;
  port?: number;
  username: string;
  privateKey?: string | Buffer;
  passphrase?: string;
  password?: string;
  agent?: string;
}

function isMissingPrivateKeyPassphraseMessage(message: string): boolean {
  return /encrypted .*private .*key detected, but no passphrase given/i.test(message);
}

function isInvalidPrivateKeyPassphraseMessage(message: string): boolean {
  return /(bad passphrase|key integrity check failed|unable to authenticate data)/i.test(message);
}

export function buildSSHConnectConfig(input: SSHConnectConfigInput): ConnectConfig {
  const hasPassword = typeof input.password === "string" && input.password.length > 0;

  // In the password login scenario, if you bring SSH_AUTH_SOCK unconditionally, ssh2 will try the agent public key first.
  // The MaxAuthTries of some hosts are very small, and the number of authentication times will be exhausted in the public key stage, resulting in the inability to enter the authentication even with the correct password.
  // Change here to "Enable only when agent is explicitly passed in"; otherwise, implicit agent is disabled by default in password mode.
  const resolvedAgent = input.agent ?? (hasPassword ? undefined : process.env["SSH_AUTH_SOCK"]);

  return {
    host: input.host,
    port: input.port ?? 22,
    username: input.username,
    privateKey: input.privateKey,
    passphrase: input.passphrase,
    password: hasPassword ? input.password : undefined,
    agent: resolvedAgent,
    // The default readyTimeout of ssh2 is 20s. When the public network is weak or the server is jittering, it is easy to misjudge the timeout.
    // The connection handshake timeout is explicitly relaxed here, which not only gives opportunities for real slow connections, but also allows error normalization to be consistent with the actual configuration.
    readyTimeout: SSH_READY_TIMEOUT_MS,
    // If the SSH project is silently disconnected by NAT, firewall or server after it is idle, the stdio channel may not be closed immediately.
    // Enable SSH-level keepalive to allow ssh2 to actively trigger error/close after continuous unresponsiveness to prevent UI tasks from being stuck in loading for a long time.
    keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
    keepaliveCountMax: SSH_KEEPALIVE_COUNT_MAX,
    // Some SSH servers only enable keyboard-interactive (challenge-response) and disable plain password.
    // After turning on tryKeyboard + interactive callback, the same password can cover this type of host to avoid "login from the command line but authentication failure in the application".
    tryKeyboard: hasPassword,
  };
}

export function createKeyboardInteractiveResponder(password?: string) {
  return (
    _name: string,
    _instructions: string,
    _lang: string,
    prompts: Array<{ prompt: string; echo: boolean }>,
    finish: (responses: string[]) => void,
  ) => {
    if (!password || prompts.length === 0) {
      finish([]);
      return;
    }

    finish(prompts.map(() => password));
  };
}

export function normalizeSSHConnectError(error: unknown): Error {
  if (
    typeof error === "object" &&
    error !== null &&
    "level" in error &&
    (error as { level?: string }).level === "client-authentication"
  ) {
    return new Error(
      "SSH authentication failed: check the username, password, or private key configuration",
    );
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "level" in error &&
    (error as { level?: string }).level === "client-timeout"
  ) {
    return new Error(
      `SSH connection handshake timed out: no SSH session was established within ${SSH_READY_TIMEOUT_MS / 1000} seconds, check the network, the server's SSH service, or differences in your terminal SSH configuration`,
    );
  }

  if (error instanceof Error) {
    // ssh2 will return different text for different private key formats (OpenSSH old/new format, PPK).
    // Previously, only a single string was matched, causing some "missing password/wrong password" scenarios to leak the underlying error text, making it difficult for users to determine which credentials should be entered.
    // This is changed to pattern normalization, which stably maps similar errors into product semantic prompts, making it easier for users to directly correct their input.
    if (isMissingPrivateKeyPassphraseMessage(error.message)) {
      return new Error(
        "The SSH private key requires a passphrase: an encrypted private key was detected, but no passphrase was provided",
      );
    }
    if (isInvalidPrivateKeyPassphraseMessage(error.message)) {
      return new Error(
        "Wrong SSH private key passphrase: the private key could not be decrypted, check that the passphrase is correct",
      );
    }
    return error;
  }

  if (typeof error === "string" && error.length > 0) {
    return new Error(error);
  }

  return new Error("SSH connection failed");
}
