import { constants, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, stat } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { join, posix } from "node:path";
import { pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";
import { redactFeedbackText, ZCODE_VERSION, ZCODE_COMMIT } from "@zcode/shared";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

interface FeedbackLogSource {
  directory: string;
  archivePrefix: string;
  exitLogsOnly?: boolean;
}

function decodeDiagnosticLog(buffer: Buffer): string | null {
  try {
    const encoding =
      buffer[0] === 0xff && buffer[1] === 0xfe
        ? "utf-16le"
        : buffer[0] === 0xfe && buffer[1] === 0xff
          ? "utf-16be"
          : "utf-8";
    const text = new TextDecoder(encoding, { fatal: true }).decode(buffer);
    for (const character of text) {
      const code = character.charCodeAt(0);
      if (code < 32 && code !== 9 && code !== 10 && code !== 13) return null;
    }
    return text;
  } catch {
    return null;
  }
}

/** The single archiving entry point for feedback uploads: allow-listed sources, bounded reads, and no raw-content fallback when decoding is not safe. */
export async function createFeedbackDiagnosticArchive(options: {
  sources: readonly FeedbackLogSource[];
  outputRootDir: string;
  now?: () => Date;
  maxTotalBytes?: number;
  onProgress?: (event: { processedBytes: number; totalBytes: number }) => void;
}): Promise<{ path: string; size: number }> {
  const now = options.now?.() ?? new Date();
  // Filter files according to the local natural day; the next day's zero o'clock is calculated by the calendar and is compatible with the 23/25 hour day of daylight saving time.
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  const isToday = (mtimeMs: number) => mtimeMs >= dayStart && mtimeMs < dayEnd;
  await mkdir(options.outputRootDir, { recursive: true });
  const outputDir = await mkdtemp(join(options.outputRootDir, "archive-"));
  const path = join(outputDir, "zcode-diagnostic-logs.zip");
  const entries: Array<{ name: string; data: Buffer }> = [];
  const skippedLogFilesByReason: Record<string, number> = {};
  const skipLogFile = (reason: string) => {
    skippedLogFilesByReason[reason] = (skippedLogFilesByReason[reason] ?? 0) + 1;
  };
  let totalBytes = 0;
  let visited = 0;
  const budget = Math.min(options.maxTotalBytes ?? MAX_TOTAL_BYTES, MAX_TOTAL_BYTES);
  try {
    options.onProgress?.({ processedBytes: 0, totalBytes: 0 });
    for (const source of options.sources) {
      // Do not follow links to the diagnostic root directory itself; normalizes system directory aliases (such as macOS /var).
      const root = await realpath(source.directory).catch(() => null);
      if (!root || !(await lstat(source.directory).catch(() => null))?.isDirectory()) continue;
      const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
        if (depth > 4 || visited >= 2000) return;
        const names = await readdir(directory, { withFileTypes: true }).catch(() => []);
        for (const entry of names.sort((a, b) => a.name.localeCompare(b.name))) {
          if (++visited > 2000) return;
          if (entry.isSymbolicLink()) continue;
          const absolutePath = join(directory, entry.name);
          const name = posix.join(prefix, entry.name);
          if (entry.isDirectory() && !source.exitLogsOnly) {
            await walk(absolutePath, name, depth + 1);
            continue;
          }
          if (
            !entry.isFile() ||
            !(source.exitLogsOnly
              ? entry.name.endsWith(".exit.log")
              : /(?:\.log(?:\.\d+)?|\.jsonl|\.ndjson)$/i.test(entry.name))
          )
            continue;
          if ((await realpath(absolutePath).catch(() => null)) !== absolutePath) {
            skipLogFile("unsafe-path");
            continue;
          }
          const info = await lstat(absolutePath).catch(() => null);
          if (
            !info?.isFile() ||
            info.nlink !== 1 ||
            info.size > MAX_FILE_BYTES ||
            totalBytes + info.size > budget ||
            !isToday(info.mtimeMs)
          ) {
            skipLogFile("metadata-policy");
            continue;
          }
          // O_NOFOLLOW prevents the file from being replaced with a link after checking; press the inode after opening to check again.
          const handle = await open(
            absolutePath,
            constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
          ).catch(() => null);
          if (!handle) {
            skipLogFile("open-failed");
            continue;
          }
          try {
            const opened = await handle.stat();
            if (
              !opened.isFile() ||
              opened.nlink !== 1 ||
              opened.ino !== info.ino ||
              opened.dev !== info.dev ||
              !isToday(opened.mtimeMs) ||
              opened.size > MAX_FILE_BYTES ||
              totalBytes + opened.size > budget
            ) {
              skipLogFile("opened-file-policy");
              continue;
            }
            // Log appending is a normal scenario: only the length confirmed when opening is read, and subsequent appending is left for the next archive.
            // Size+1 cannot be used to detect growth and discard the entire active log; short reads are still skipped conservatively.
            const bytes = Buffer.alloc(opened.size);
            let length = 0;
            while (length < bytes.length) {
              const read = await handle.read(bytes, length, bytes.length - length, length);
              if (!read.bytesRead) break;
              length += read.bytesRead;
            }
            if (length !== opened.size) {
              skipLogFile("short-read");
              continue;
            }
            const text = decodeDiagnosticLog(bytes.subarray(0, length));
            if (text === null) {
              skipLogFile("unsupported-text");
              continue;
            }
            const data = Buffer.from(redactFeedbackText(text, { diagnostic: true }));
            if (data.length > MAX_FILE_BYTES || totalBytes + data.length > budget) {
              skipLogFile("redacted-size-limit");
              continue;
            }
            entries.push({ name, data });
            totalBytes += Math.max(length, data.length);
          } finally {
            await handle.close();
          }
        }
      };
      await walk(root, source.archivePrefix, 0);
    }
    const zip = new ZipFile();
    const output = createWriteStream(path, { mode: 0o600 });
    // The pipeline monitors ZIP and output errors at the same time, and cleans the directory if it fails.
    const writing = pipeline(zip.outputStream, output);
    for (const entry of entries) zip.addBuffer(entry.data, entry.name);
    zip.addBuffer(
      Buffer.from(
        [
          "ZCode diagnostic logs",
          `timestamp: ${now.toISOString()}`,
          `appVersion: ${ZCODE_VERSION}`,
          `commit: ${ZCODE_COMMIT}`,
          `node: ${process.version}`,
          `os: ${platform()} ${release()} (${arch()})`,
          `includedLogFiles: ${entries.length}`,
          `skippedLogFiles: ${Object.values(skippedLogFilesByReason).reduce((sum, count) => sum + count, 0)}`,
          `skippedLogFilesByReason: ${JSON.stringify(skippedLogFilesByReason)}`,
          "Scope: diagnostic text log files modified today (local time); credentials and structured payloads redacted.",
        ].join("\n"),
      ),
      "about.txt",
    );
    zip.end();
    await writing;
    const { size } = await stat(path);
    options.onProgress?.({ processedBytes: size, totalBytes: size });
    return { path, size };
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }
}
