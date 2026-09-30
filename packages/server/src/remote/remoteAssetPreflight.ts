import type { IRemoteBackend, StdioStream } from "@zcode/server/remote/backend.js";
import { waitForClose } from "@zcode/server/remote/deployShared.js";

export type RemoteDownloadTool = "curl" | "wget";
export type RemoteSha256Tool = "sha256sum" | "shasum" | "openssl";

export interface RemoteAssetTools {
  download: RemoteDownloadTool;
  tar: "tar";
  sha256: RemoteSha256Tool;
}

interface RemoteAssetPreflightLoggers {
  log: (...args: unknown[]) => void;
}

export async function detectRemoteAssetTools(
  backend: IRemoteBackend,
  loggers: RemoteAssetPreflightLoggers,
): Promise<RemoteAssetTools> {
  loggers.log("[remote-assets] preflight: checking remote download tools");

  const stream = await backend.exec(buildPreflightCommand());
  const stdoutPromise = collectStdout(stream);
  await waitForClose(stream);
  const stdout = await stdoutPromise;

  const values = parseToolLines(stdout);
  const download = parseDownloadTool(values.download);
  const tar = values.tar === "tar" ? "tar" : null;
  const sha256 = parseSha256Tool(values.sha256);

  if (!download) {
    throw new Error(
      'The remote server is missing curl or wget, so ZCode remote assets cannot be downloaded directly. Please install curl/wget, or switch back to "download locally, then upload".',
    );
  }
  if (!tar) {
    throw new Error(
      'The remote server is missing tar, so ZCode remote assets cannot be extracted. Please install tar, or switch back to "download locally, then upload".',
    );
  }
  if (!sha256) {
    throw new Error(
      'The remote server is missing sha256sum, shasum, or openssl, so ZCode remote assets cannot be verified. Please install one of these checksum tools, or switch back to "download locally, then upload".',
    );
  }

  loggers.log(
    `[remote-assets] preflight: selected tools download=${download} tar=${tar} sha256=${sha256}`,
  );

  return { download, tar, sha256 };
}

function buildPreflightCommand(): string {
  return [
    "download=",
    "if command -v curl >/dev/null 2>&1; then download=curl; elif command -v wget >/dev/null 2>&1; then download=wget; fi",
    "tar_tool=",
    "if command -v tar >/dev/null 2>&1; then tar_tool=tar; fi",
    "sha_tool=",
    "if command -v sha256sum >/dev/null 2>&1; then sha_tool=sha256sum; elif command -v shasum >/dev/null 2>&1; then sha_tool=shasum; elif command -v openssl >/dev/null 2>&1; then sha_tool=openssl; fi",
    'printf \'download=%s\ntar=%s\nsha256=%s\n\' "$download" "$tar_tool" "$sha_tool"',
  ].join("; ");
}

function parseToolLines(stdout: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    values[line.slice(0, separatorIndex)] = line.slice(separatorIndex + 1).trim();
  }
  return values;
}

function parseDownloadTool(value?: string): RemoteDownloadTool | null {
  return value === "curl" || value === "wget" ? value : null;
}

function parseSha256Tool(value?: string): RemoteSha256Tool | null {
  return value === "sha256sum" || value === "shasum" || value === "openssl" ? value : null;
}

async function collectStdout(stream: StdioStream): Promise<string> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    let closeFallbackTimer: ReturnType<typeof setTimeout> | null = null;
    const clearCloseFallback = () => {
      if (!closeFallbackTimer) {
        return;
      }
      clearTimeout(closeFallbackTimer);
      closeFallbackTimer = null;
    };
    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearCloseFallback();
      resolve(stdout);
    };
    const scheduleCloseFallback = () => {
      if (settled) {
        return;
      }
      clearCloseFallback();
      closeFallbackTimer = setTimeout(settle, 50);
    };

    stream.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
      if (closeFallbackTimer) {
        scheduleCloseFallback();
      }
    });
    stream.stdout.on("end", settle);
    stream.stdout.on("close", settle);
    stream.stdout.on("error", settle);
    // ssh2's exit/onClose may be earlier than stdout data; collection cannot be ended immediately onClose.
    // This gives stdout a short emptying window, while still handling stdout without triggering the backend implementation of end/close to avoid preflight getting stuck.
    stream.onClose(scheduleCloseFallback);
  });
}
