import type { IDisposable, Event } from "@zcode/rpc";

export interface RemoteEnvironment {
  platform: string; // "linux" | "darwin"
  arch: string; // "x64" | "arm64"
}

export interface StdioStream {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  onClose: Event<number>; // exit code
}

export type RemoteDisconnectReason = "error" | "close" | "end";

export interface RemoteDisconnectEvent {
  reason: RemoteDisconnectReason;
  error?: Error;
}

export interface RemoteUploadProgress {
  uploadedBytes: number;
  totalBytes: number;
}

export interface RemoteUploadOptions {
  onProgress?: (progress: RemoteUploadProgress) => void;
  signal?: AbortSignal;
}

export interface IRemoteBackend extends IDisposable {
  /** WSL optional runtime network resolution; other remote types remain uninjected. */
  resolveRuntimeProxy?(proxyUrl: string): Promise<string>;
  /** Wait for the underlying process/connection created by the current backend itself to complete cleanup; must not extend to the shared runtime. */
  disposeAndWait?(options?: { graceTimeoutMs?: number; killWaitTimeoutMs?: number }): Promise<void>;
  /** Remote underlying connection disconnect event; used to compensate for half-open connections where the stdio channel was not closed in time. */
  onDidDisconnect?: Event<RemoteDisconnectEvent>;
  /** Detect remote environment (no Node.js required) */
  detect(): Promise<RemoteEnvironment>;
  /** Upload a file to the remote machine */
  upload(localPath: string, remotePath: string, options?: RemoteUploadOptions): Promise<void>;
  /** Execute a command on the remote machine, returning stdio streams */
  exec(command: string): Promise<StdioStream>;
  /** Check if a remote file exists */
  exists(remotePath: string): Promise<boolean>;
  /** Read a small remote file (e.g. version string) */
  readFile(remotePath: string): Promise<string>;
}
