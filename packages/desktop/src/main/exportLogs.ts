/* eslint-disable max-lines -- The log export flow spans file collection, redaction, and packaging; keeping it in one place makes troubleshooting easier and keeps behavior consistent */
import { constants, createReadStream, createWriteStream } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";

import {
  createFeedbackDiagnosticArchive,
  getAppConfigDir,
  getExportLogDir as getDefaultExportLogDir,
  getExportLogStageDir as getDefaultExportLogStageDir,
  getFeedbackLogArchiveDir as getDefaultFeedbackLogArchiveDir,
} from "@zcode/services/node";
import { createAboutSnapshot, formatAboutDetail, readBuildMetadata } from "./about.js";
import { logger } from "./logger.js";

function getZCodeDataDir() {
  return getAppConfigDir();
}

function getZCodeCliDir() {
  return join(homedir(), ".zcode", "cli");
}

function getZCodeCliLogDir() {
  return join(getZCodeCliDir(), "log");
}

/**
 * The directory where Computer Use Helper is run. Helper on macOS is started by LaunchServices, stderr is discarded by the system,
 * So it puts the lifecycle and background input diagnostic tee into `<socket>.exit.log` (see zcode-cua
 * helperExitLogPathFor). There are also `.tokens` broker credentials in the same directory, which must be whitelisted by file name when collecting.
 */
function getCuaHelperRunDir() {
  return join(homedir(), ".zcode", "computer-use", "run");
}

function isCuaHelperDiagnosticFileName(fileName: string): boolean {
  return fileName.endsWith(".exit.log");
}

interface LogArchiveFileEntry {
  absolutePath: string;
  archivePath: string;
}

interface LogArchiveArtifacts {
  files: LogArchiveFileEntry[];
  aboutContent: string;
}

interface CreateLogArchiveArtifactsOptions {
  now?: () => Date;
  lookbackDays?: number;
}

interface LogArchiveSkippedFileEntry {
  absolutePath: string;
  archivePath: string;
  error: string;
}

interface ExportLogsDependencies {
  now?: () => Date;
  getZCodeDataDir?: () => string;
  getExportLogStageDir?: () => string;
  getExportLogDir?: () => string;
  createLogArchiveArtifacts?: (
    sourceDir: string,
    options?: CreateLogArchiveArtifactsOptions,
  ) => Promise<LogArchiveArtifacts>;
  writeLogArchiveZip?: (
    outputPath: string,
    artifacts: LogArchiveArtifacts,
    options?: WriteLogArchiveZipOptions,
  ) => Promise<void>;
  writeLogArchiveDirectory?: (outputPath: string, artifacts: LogArchiveArtifacts) => Promise<void>;
  showItemInFolder?: (path: string) => Promise<void> | void;
}

interface WriteLogArchiveZipOptions {
  stageRootDir?: string;
}

interface CreateFeedbackLogArchiveFromExportLogsOptions {
  now?: () => Date;
  outputRootDir?: string;
  stageRootDir?: string;
  onProgress?: (event: { processedBytes: number; totalBytes: number }) => void;
}

function formatTimestamp(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function normalizeArchivePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function escapeRegExp(path: string): string {
  return path.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globPatternToRegExp(pattern: string): RegExp {
  const normalizedPattern = normalizeArchivePath(pattern);
  return new RegExp(`^${normalizedPattern.split("*").map(escapeRegExp).join(".*")}$`);
}

/**
 * Glob patterns to exclude from the exported log archive.
 * Each pattern is relative to the source directory being archived.
 */
const ZIP_EXCLUDE_PATTERNS: string[] = [];

const ZIP_EXCLUDE_REGEXES = ZIP_EXCLUDE_PATTERNS.map(globPatternToRegExp);
const RETIRED_ACP_RUNTIME_ARCHIVE_PATHS = [
  "acp-auth",
  "acp-config",
  "acp-stream-diagnostics",
  "acp-traffic-proxy",
] as const;
const HIGH_VOLUME_RUNTIME_ARCHIVE_PATHS = ["dev"] as const;
const DOCSHOT_ARCHIVE_PATH_PREFIXES = ["docshot-backup-"] as const;
const DOCSHOT_ARCHIVE_PATHS = ["docshot-assets"] as const;
const NON_LOG_STATE_ARCHIVE_PATHS = [
  "agent-config",
  "certs",
  "repo",
  "sessions",
  "session-bindings",
  "checkpoints",
] as const;
const SENSITIVE_CREDENTIAL_ARCHIVE_FILE_NAMES = new Set(["credentials.json", ".credentials.json"]);
const EXCLUDED_ARCHIVE_DIRECTORY_NAMES = new Set(["debug"]);
const DEFAULT_LOG_EXPORT_LOOKBACK_DAYS = 3;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const REDACTED_PLACEHOLDER = "***REDACTED***";
// Sensitive key name "family": as long as the key name contains these substrings, it is considered sensitive (all-inclusive),
// This allows overriding custom naming (such as db_password, my_secret, x-conn-string, etc.) without having to enumerate them exactly one by one.
// Note: `token` / `auth`, etc. are loose substrings. Use the whitelist below to exclude accidental items (such as input_tokens, author).
const SENSITIVE_KEY_SUBSTRING_PATTERN = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "credential",
  "api(?:_|-)?key",
  "access(?:_|-)?key",
  "private(?:_|-)?key",
  "auth",
  "cookie",
  "dsn",
  "conn(?:ection)?(?:_|-)?str(?:ing)?",
  "database(?:_|-)?url",
  "db(?:_|-)?url",
].join("|");
const SENSITIVE_KEY_NAME_REGEX = new RegExp(`(?:${SENSITIVE_KEY_SUBSTRING_PATTERN})`, "i");
// Whitelist: Common key names that hit sensitive substrings but are not actually keys to avoid removing the context needed for troubleshooting.
// Any "*_tokens" cannot be whitelisted, otherwise access_tokens/session_tokens will be exported unchanged;
// max_tokens/budget_tokens is the model output and thinking budget, not the credentials, and needs to be retained to determine whether the provider request hits the limit;
// Therefore, only clear LLM token count/budget fields and common words containing "auth" such as author/authority are allowed here.
const NON_SENSITIVE_KEY_NAME_ALLOWLIST_REGEX =
  /^(?:public(?:_|-)?key|keywords?|tokenizer|token(?:_|-)?count|(?:prompt|completion|total|input|output|cached|reasoning|max|budget|accepted(?:_|-)?prediction|rejected(?:_|-)?prediction|tool(?:_|-)?use(?:_|-)?prompt)(?:_|-)?tokens|author(?:s|ity|ed)?)$/i;

function isSensitiveKeyName(keyName: string): boolean {
  if (NON_SENSITIVE_KEY_NAME_ALLOWLIST_REGEX.test(keyName)) {
    return false;
  }
  return SENSITIVE_KEY_NAME_REGEX.test(keyName);
}

// The following regular expression first loosely captures "key name + value", and then uses isSensitiveKeyName to determine whether to desensitize it.
// In this way, the key name blacklist is no longer a hard-coded list, but "sensitive families + wildcards + whitelist exceptions".
const JSON_STYLE_SENSITIVE_VALUE_REGEX =
  /(["'])([A-Za-z0-9_.-]+)\1(\s*:\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,\r\n}\]]+)/g;
const ASSIGNMENT_STYLE_SENSITIVE_VALUE_REGEX =
  /((?:^|\n)[ \t]*)([A-Za-z0-9_.-]+)([ \t]*=[ \t]*)([^\r\n#]+)/g;
const HEADER_STYLE_SENSITIVE_VALUE_REGEX =
  /((?:^|\n)[ \t]*)([A-Za-z0-9-]+)([ \t]*:[ \t]*)([^\r\n]+)/g;
const BEARER_TOKEN_REGEX = /(Bearer\s+)([^\s"']+)/g;
const QUERY_TOKEN_REGEX =
  /([?&](?:key|api(?:_|-)?key|access(?:_|-)?token|refresh(?:_|-)?token|token|password|passwd|pwd|secret|client(?:_|-)?secret|auth(?:_|-)?token|session(?:_|-)?token)=)([^&#\s]+)/gi;
// Desensitization by "value form": the credential part in the connection string scheme://user:pass@host,
// Database connection information such as postgres/mysql/mongodb/redis/amqp can be covered without relying on key names. Keep scheme and host for easy troubleshooting.
// The username field is allowed to be empty to cover redis://:password@host; the password field is greedily matched to the last @ (the host field does not contain @),
// In this way, passwords containing naked @ (such as P@ssw0rd) can be completely desensitized without any remaining fragments.
const CONNECTION_STRING_CREDENTIALS_REGEX =
  /\b([a-z][a-z0-9+.-]*:\/\/)([^:/\s]*):([^/\s]+)@(?=[^@/\s])/gi;
const TEXT_DETECTION_SAMPLE_BYTES = 64 * 1024;
const EMPTY_BOM = Buffer.alloc(0);

type SupportedTextEncoding = "utf-8" | "utf-16le" | "utf-16be";

interface TextFileEncodingInfo {
  encoding: SupportedTextEncoding;
  bomLength: number;
  bomBytes: Buffer;
}

interface TextDecodingScore {
  preferredCharRatio: number;
  invalidCharRatio: number;
}

function redactValue(rawValue: string): string {
  const leadingSpaces = rawValue.match(/^\s*/)?.[0] ?? "";
  const trailingSpaces = rawValue.match(/\s*$/)?.[0] ?? "";
  const core = rawValue.trim();
  const quote =
    core.startsWith('"') && core.endsWith('"')
      ? '"'
      : core.startsWith("'") && core.endsWith("'")
        ? "'"
        : "";
  const redacted = quote ? `${quote}${REDACTED_PLACEHOLDER}${quote}` : REDACTED_PLACEHOLDER;
  return `${leadingSpaces}${redacted}${trailingSpaces}`;
}

function redactHeaderValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (/^bearer\s+/i.test(trimmed)) {
    return trimmed.replace(/^bearer\s+.+$/i, `Bearer ${REDACTED_PLACEHOLDER}`);
  }
  return REDACTED_PLACEHOLDER;
}

function redactConnectionStringCredentials(rawContent: string): string {
  // postgres://admin:secret@host → postgres://***REDACTED***:***REDACTED***@host
  return rawContent.replace(
    CONNECTION_STRING_CREDENTIALS_REGEX,
    (_match, scheme: string) => `${scheme}${REDACTED_PLACEHOLDER}:${REDACTED_PLACEHOLDER}@`,
  );
}

function sanitizeSensitiveLogContent(rawContent: string): string {
  // The export log cannot be copied as the file is: the user configuration and token/apiKey in the protocol log will be brought out together.
  // Online troubleshooting needs to "preserve the file structure and context", but the key ontology should not be leaked;
  // Here, common sensitive values ​​are uniformly desensitized during the export phase, and fields and log lines are still intact, supporting continued problem locating.
  // The key name is no longer a hard-coded blacklist, but "sensitive key name family + substring wildcard + whitelist exception" (isSensitiveKeyName),
  // And overlay value-based connection string desensitization to cover custom-named sensitive information such as database connection strings.
  return redactConnectionStringCredentials(rawContent)
    .replace(
      JSON_STYLE_SENSITIVE_VALUE_REGEX,
      (match, quote: string, keyName: string, separator: string, rawValue: string) =>
        isSensitiveKeyName(keyName)
          ? `${quote}${keyName}${quote}${separator}${redactValue(rawValue)}`
          : match,
    )
    .replace(
      ASSIGNMENT_STYLE_SENSITIVE_VALUE_REGEX,
      (match, prefix: string, keyName: string, separator: string, rawValue: string) =>
        isSensitiveKeyName(keyName)
          ? `${prefix}${keyName}${separator}${redactValue(rawValue)}`
          : match,
    )
    .replace(
      HEADER_STYLE_SENSITIVE_VALUE_REGEX,
      (match, prefix: string, headerName: string, separator: string, rawValue: string) =>
        isSensitiveKeyName(headerName)
          ? `${prefix}${headerName}${separator}${redactHeaderValue(rawValue)}`
          : match,
    )
    .replace(BEARER_TOKEN_REGEX, `$1${REDACTED_PLACEHOLDER}`)
    .replace(QUERY_TOKEN_REGEX, `$1${REDACTED_PLACEHOLDER}`);
}

function detectUtf16EncodingByNullPattern(sample: Buffer): SupportedTextEncoding | null {
  if (sample.length < 4) {
    return null;
  }

  let evenByteCount = 0;
  let oddByteCount = 0;
  let evenNullCount = 0;
  let oddNullCount = 0;

  for (let index = 0; index < sample.length; index += 1) {
    if (index % 2 === 0) {
      evenByteCount += 1;
      if (sample[index] === 0) {
        evenNullCount += 1;
      }
      continue;
    }

    oddByteCount += 1;
    if (sample[index] === 0) {
      oddNullCount += 1;
    }
  }

  const evenNullRatio = evenNullCount / Math.max(evenByteCount, 1);
  const oddNullRatio = oddNullCount / Math.max(oddByteCount, 1);
  const likelyUtf16Ratio = 0.3;
  const noiseThreshold = 0.1;
  if (oddNullRatio >= likelyUtf16Ratio && evenNullRatio <= noiseThreshold) {
    return "utf-16le";
  }
  if (evenNullRatio >= likelyUtf16Ratio && oddNullRatio <= noiseThreshold) {
    return "utf-16be";
  }
  return null;
}

function isLikelyAsciiTextByte(byteValue: number): boolean {
  return (
    byteValue === 0x09 ||
    byteValue === 0x0a ||
    byteValue === 0x0d ||
    (byteValue >= 0x20 && byteValue <= 0x7e)
  );
}

function isPreferredTextCodePoint(codePoint: number): boolean {
  if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d || codePoint === 0x20) {
    return true;
  }
  if (codePoint >= 0x20 && codePoint <= 0x7e) {
    return true;
  }
  if (codePoint >= 0x4e00 && codePoint <= 0x9fff) {
    return true;
  }
  if (codePoint >= 0x3400 && codePoint <= 0x4dbf) {
    return true;
  }
  if (codePoint >= 0x3000 && codePoint <= 0x303f) {
    return true;
  }
  if (codePoint >= 0xff00 && codePoint <= 0xffef) {
    return true;
  }
  if (codePoint >= 0x3040 && codePoint <= 0x30ff) {
    return true;
  }
  if (codePoint >= 0xac00 && codePoint <= 0xd7af) {
    return true;
  }
  return false;
}

function scoreDecodedTextForEncodingDetection(decodedText: string): TextDecodingScore {
  let totalCodePointCount = 0;
  let preferredCodePointCount = 0;
  let invalidCodePointCount = 0;

  for (const character of decodedText) {
    totalCodePointCount += 1;
    const codePoint = character.codePointAt(0) ?? 0;

    if (
      codePoint === 0xfffd ||
      codePoint === 0 ||
      codePoint === 0x7f ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      (codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d)
    ) {
      invalidCodePointCount += 1;
      continue;
    }
    if (isPreferredTextCodePoint(codePoint)) {
      preferredCodePointCount += 1;
    }
  }

  const denominator = Math.max(totalCodePointCount, 1);
  return {
    preferredCharRatio: preferredCodePointCount / denominator,
    invalidCharRatio: invalidCodePointCount / denominator,
  };
}

function detectUtf16EncodingByDecodedTextScore(sample: Buffer): SupportedTextEncoding | null {
  if (sample.length < 4) {
    return null;
  }

  const normalizedSampleLength = sample.length - (sample.length % 2);
  if (normalizedSampleLength < 4) {
    return null;
  }
  const normalizedSample = sample.subarray(0, normalizedSampleLength);

  const utf16LeScore = scoreDecodedTextForEncodingDetection(
    new TextDecoder("utf-16le").decode(normalizedSample),
  );
  const utf16BeScore = scoreDecodedTextForEncodingDetection(
    new TextDecoder("utf-16be").decode(normalizedSample),
  );

  const minimumPreferredCharRatio = 0.55;
  const maximumInvalidCharRatio = 0.2;
  const minimumPreferredCharRatioGap = 0.08;

  const utf16LeQualified =
    utf16LeScore.preferredCharRatio >= minimumPreferredCharRatio &&
    utf16LeScore.invalidCharRatio <= maximumInvalidCharRatio;
  const utf16BeQualified =
    utf16BeScore.preferredCharRatio >= minimumPreferredCharRatio &&
    utf16BeScore.invalidCharRatio <= maximumInvalidCharRatio;

  if (utf16LeQualified && !utf16BeQualified) {
    return "utf-16le";
  }
  if (utf16BeQualified && !utf16LeQualified) {
    return "utf-16be";
  }
  if (!utf16LeQualified && !utf16BeQualified) {
    return null;
  }

  const preferredRatioGap = Math.abs(
    utf16LeScore.preferredCharRatio - utf16BeScore.preferredCharRatio,
  );
  if (preferredRatioGap >= minimumPreferredCharRatioGap) {
    return utf16LeScore.preferredCharRatio > utf16BeScore.preferredCharRatio
      ? "utf-16le"
      : "utf-16be";
  }

  return utf16LeScore.invalidCharRatio <= utf16BeScore.invalidCharRatio ? "utf-16le" : "utf-16be";
}

function isValidUtf8Sample(sample: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}

function detectUtf16EncodingByAsciiPairPattern(sample: Buffer): SupportedTextEncoding | null {
  if (sample.length < 4) {
    return null;
  }

  let utf16LeRunLength = 0;
  let utf16BeRunLength = 0;
  let utf16LeAsciiRunScore = 0;
  let utf16BeAsciiRunScore = 0;

  // There will be a situation in CJK text that "the low byte of a single code element is exactly 0" (such as U+4E00),
  // Direct counting of `0x00 + ASCII` pairs will misinterpret these discrete noises as other endianness.
  // Here the statistics are changed to "continuous ASCII-zero byte runs", and only segments of English tokens (api key/header) are used as valid signals.
  const flushRunScore = (runLength: number): number => (runLength >= 3 ? runLength : 0);

  for (let index = 0; index + 1 < sample.length; index += 2) {
    const leftByte = sample[index] ?? 0;
    const rightByte = sample[index + 1] ?? 0;

    if (rightByte === 0 && isLikelyAsciiTextByte(leftByte)) {
      utf16LeRunLength += 1;
      utf16BeAsciiRunScore += flushRunScore(utf16BeRunLength);
      utf16BeRunLength = 0;
      continue;
    }
    if (leftByte === 0 && isLikelyAsciiTextByte(rightByte)) {
      utf16BeRunLength += 1;
      utf16LeAsciiRunScore += flushRunScore(utf16LeRunLength);
      utf16LeRunLength = 0;
      continue;
    }

    utf16LeAsciiRunScore += flushRunScore(utf16LeRunLength);
    utf16BeAsciiRunScore += flushRunScore(utf16BeRunLength);
    utf16LeRunLength = 0;
    utf16BeRunLength = 0;
  }

  utf16LeAsciiRunScore += flushRunScore(utf16LeRunLength);
  utf16BeAsciiRunScore += flushRunScore(utf16BeRunLength);

  const minimumAsciiRunScore = 6;
  const dominanceRatio = 1.5;
  if (
    utf16LeAsciiRunScore >= minimumAsciiRunScore &&
    utf16LeAsciiRunScore >= utf16BeAsciiRunScore * dominanceRatio
  ) {
    return "utf-16le";
  }
  if (
    utf16BeAsciiRunScore >= minimumAsciiRunScore &&
    utf16BeAsciiRunScore >= utf16LeAsciiRunScore * dominanceRatio
  ) {
    return "utf-16be";
  }
  return null;
}

function detectTextFileEncoding(sample: Buffer): TextFileEncodingInfo | null {
  if (sample.length === 0) {
    return { encoding: "utf-8", bomLength: 0, bomBytes: EMPTY_BOM };
  }

  if (sample.length >= 3 && sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) {
    return {
      encoding: "utf-8",
      bomLength: 3,
      bomBytes: Buffer.from([0xef, 0xbb, 0xbf]),
    };
  }

  if (sample.length >= 2 && sample[0] === 0xff && sample[1] === 0xfe) {
    return {
      encoding: "utf-16le",
      bomLength: 2,
      bomBytes: Buffer.from([0xff, 0xfe]),
    };
  }
  if (sample.length >= 2 && sample[0] === 0xfe && sample[1] === 0xff) {
    return {
      encoding: "utf-16be",
      bomLength: 2,
      bomBytes: Buffer.from([0xfe, 0xff]),
    };
  }

  if (!sample.includes(0) && isValidUtf8Sample(sample)) {
    return { encoding: "utf-8", bomLength: 0, bomBytes: EMPTY_BOM };
  }

  // UTF-16 text with a high CJK proportion without BOM may have a low proportion of null bytes.
  // Null-ratio alone will be misjudged as "non-text" and copied as it is, causing sensitive fields to be desensitized.
  // Here, "ASCII-zero byte pair" covert detection (such as `OPENAI_API_KEY=\r\n`) is added to cover mixed text scenarios in real logs.
  const utf16Encoding =
    detectUtf16EncodingByAsciiPairPattern(sample) ??
    detectUtf16EncodingByNullPattern(sample) ??
    detectUtf16EncodingByDecodedTextScore(sample);
  if (!utf16Encoding) {
    // UTF-16 text with no BOM and no null bytes, often seen in pure CJK content.
    // The UTF-8 fatal decode of this type of sample will fail; processing it as UTF-8 will produce garbled characters and miss sensitive field matching.
    // Cover-up strategy: If UTF-8 is legal, it will be treated as UTF-8. If it is illegal and cannot be recognized as UTF-16, it will be regarded as binary.
    if (isValidUtf8Sample(sample)) {
      return { encoding: "utf-8", bomLength: 0, bomBytes: EMPTY_BOM };
    }
    return null;
  }
  return { encoding: utf16Encoding, bomLength: 0, bomBytes: EMPTY_BOM };
}

async function readFileSample(
  absolutePath: string,
  sampleBytes = TEXT_DETECTION_SAMPLE_BYTES,
): Promise<Buffer> {
  const fileHandle = await open(absolutePath, "r");
  try {
    const buffer = Buffer.alloc(sampleBytes);
    const { bytesRead } = await fileHandle.read(buffer, 0, sampleBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await fileHandle.close();
  }
}

function encodeTextWithEncoding(text: string, encoding: SupportedTextEncoding): Buffer {
  if (encoding === "utf-8") {
    return Buffer.from(text, "utf-8");
  }
  if (encoding === "utf-16le") {
    return Buffer.from(text, "utf16le");
  }
  const encodedBuffer = Buffer.from(text, "utf16le");
  encodedBuffer.swap16();
  return encodedBuffer;
}

function splitByCompleteLine(content: string): {
  completeChunk: string;
  pendingChunk: string;
} {
  const lastLineFeedIndex = content.lastIndexOf("\n");
  if (lastLineFeedIndex >= 0) {
    return {
      completeChunk: content.slice(0, lastLineFeedIndex + 1),
      pendingChunk: content.slice(lastLineFeedIndex + 1),
    };
  }

  const lastCarriageReturnIndex = content.lastIndexOf("\r");
  if (lastCarriageReturnIndex >= 0 && lastCarriageReturnIndex < content.length - 1) {
    return {
      completeChunk: content.slice(0, lastCarriageReturnIndex + 1),
      pendingChunk: content.slice(lastCarriageReturnIndex + 1),
    };
  }

  return { completeChunk: "", pendingChunk: content };
}

function createSensitiveContentSanitizerTransform(encoding: SupportedTextEncoding): Transform {
  const decoder = new TextDecoder(encoding);
  let pendingChunk = "";

  return new Transform({
    transform(chunk, _chunkEncoding, callback) {
      try {
        const rawChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const decodedChunk = decoder.decode(rawChunk, { stream: true });
        const mergedChunk = `${pendingChunk}${decodedChunk}`;
        const { completeChunk, pendingChunk: nextPendingChunk } = splitByCompleteLine(mergedChunk);
        pendingChunk = nextPendingChunk;

        if (completeChunk.length === 0) {
          callback();
          return;
        }
        const sanitizedChunk = sanitizeSensitiveLogContent(completeChunk);
        callback(null, encodeTextWithEncoding(sanitizedChunk, encoding));
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback) {
      try {
        const remainingContent = `${pendingChunk}${decoder.decode()}`;
        if (remainingContent.length === 0) {
          callback();
          return;
        }
        const sanitizedChunk = sanitizeSensitiveLogContent(remainingContent);
        callback(null, encodeTextWithEncoding(sanitizedChunk, encoding));
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}

async function sanitizeTextLogFileToDestination(
  sourcePath: string,
  destinationPath: string,
  encodingInfo: TextFileEncodingInfo,
): Promise<void> {
  const readStream = createReadStream(sourcePath, {
    start: encodingInfo.bomLength,
  });
  const writeStream = createWriteStream(destinationPath);

  if (encodingInfo.bomLength > 0) {
    writeStream.write(encodingInfo.bomBytes);
  }

  await pipeline(
    readStream,
    createSensitiveContentSanitizerTransform(encodingInfo.encoding),
    writeStream,
  );
}

function isExcludedCachePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath);
  return (
    normalizedRelativePath === "Library/Caches" ||
    normalizedRelativePath.startsWith("Library/Caches/")
  );
}

function isRetiredAcpRuntimePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath);
  return RETIRED_ACP_RUNTIME_ARCHIVE_PATHS.some(
    (archivePath) =>
      normalizedRelativePath === archivePath ||
      normalizedRelativePath.startsWith(`${archivePath}/`),
  );
}

function isHighVolumeRuntimeArchivePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath);
  return HIGH_VOLUME_RUNTIME_ARCHIVE_PATHS.some(
    (archivePath) =>
      normalizedRelativePath === archivePath ||
      normalizedRelativePath.startsWith(`${archivePath}/`),
  );
}

function isDocshotArchivePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath);
  const firstSegment = normalizedRelativePath.split("/")[0] ?? "";
  if (DOCSHOT_ARCHIVE_PATHS.includes(firstSegment as (typeof DOCSHOT_ARCHIVE_PATHS)[number])) {
    return true;
  }
  return DOCSHOT_ARCHIVE_PATH_PREFIXES.some((prefix) => firstSegment.startsWith(prefix));
}

function isNonLogStateArchivePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath);
  return NON_LOG_STATE_ARCHIVE_PATHS.some((archivePath) =>
    normalizedRelativePath.startsWith(archivePath),
  );
}

function isSensitiveCredentialArchivePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath).toLowerCase();
  const fileName = normalizedRelativePath.split("/").at(-1) ?? "";
  return SENSITIVE_CREDENTIAL_ARCHIVE_FILE_NAMES.has(fileName);
}

function isExcludedDirectoryArchivePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath).toLowerCase();
  return normalizedRelativePath
    .split("/")
    .some((segment) => EXCLUDED_ARCHIVE_DIRECTORY_NAMES.has(segment));
}

function isExcludedRelativePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath);
  // In the past, complete log export only did content desensitization, and the credentials.json file itself was still put into the package.
  // The credential store file is not a troubleshooting log, and different providers may reuse files with the same name; therefore it is skipped by file name during the collection inventory phase.
  if (isSensitiveCredentialArchivePath(normalizedRelativePath)) {
    return true;
  }
  // The debug directory is usually a model/runtime high-frequency trace, not a log package material to be delivered by the user.
  // In the past, explicit collection of ~/.zcode/cli/debug would bring this type of context into manual export and feedback of complete logs, which are skipped here by directory segment.
  if (isExcludedDirectoryArchivePath(normalizedRelativePath)) {
    return true;
  }
  if (isNonLogStateArchivePath(normalizedRelativePath)) {
    return true;
  }
  // ~/.zcode/v2/dev saves high-frequency protocol streams such as stdio-traffic, which will accumulate to GB level on a real machine.
  // Far exceeds the maximum size limit for feedback attachments and should not be included with the diagnostic kit.
  if (isHighVolumeRuntimeArchivePath(normalizedRelativePath)) {
    return true;
  }
  // The size of docshot historical backup and material directory can reach GB level.
  // and are not diagnostic logs required for user feedback.
  if (isDocshotArchivePath(normalizedRelativePath)) {
    return true;
  }
  // The ACP runtime directory has been retired, and hundreds of MB of packet captures and old authentication files may still remain in old user data.
  // The current running configuration has been moved to agent-config; continuing to export these old directories will cause the export to be without feedback for a long time, and may also bring out the old agent certificate private key.
  if (isRetiredAcpRuntimePath(normalizedRelativePath)) {
    return true;
  }
  // Library/Caches is a runtime cache, not a log required for troubleshooting; exporting it will only enlarge the log package.
  if (isExcludedCachePath(normalizedRelativePath)) {
    return true;
  }

  return ZIP_EXCLUDE_REGEXES.some((pattern) => pattern.test(normalizedRelativePath));
}

function shouldApplyLogExportRetention(archivePath: string): boolean {
  const normalizedArchivePath = normalizeArchivePath(archivePath);
  if (
    normalizedArchivePath.startsWith("logs/") ||
    normalizedArchivePath.startsWith(".zcode/cli/log/")
  ) {
    return true;
  }

  return false;
}

async function filterRecentLogArchiveFiles(
  files: LogArchiveFileEntry[],
  options: CreateLogArchiveArtifactsOptions = {},
): Promise<LogArchiveFileEntry[]> {
  const lookbackDays = options.lookbackDays ?? DEFAULT_LOG_EXPORT_LOOKBACK_DAYS;
  if (lookbackDays <= 0) {
    return files;
  }

  const now = options.now ?? (() => new Date());
  const cutoffMs = now().getTime() - lookbackDays * MILLISECONDS_PER_DAY;
  const recentFiles: LogArchiveFileEntry[] = [];

  for (const file of files) {
    if (!shouldApplyLogExportRetention(file.archivePath)) {
      recentFiles.push(file);
      continue;
    }

    const fileStats = await stat(file.absolutePath).catch(() => null);
    // Exported logs used to be packaged in full by directory. After running for a long time, old diagnostics would enlarge the log package to hundreds of MB.
    // Here, only log files that can be reproduced in a time window are retained for the past 3 days based on mtime;
    // Troubleshooting configurations such as settings do not participate in filtering to avoid the loss of configurations that have not been modified for a long time but still affect the current behavior.
    if (fileStats?.isFile() && fileStats.mtimeMs >= cutoffMs) {
      recentFiles.push(file);
    }
  }

  return recentFiles;
}

function createAboutContent(): string {
  const snapshot = createAboutSnapshot({ buildMetadata: readBuildMetadata() });
  return formatAboutDetail(snapshot);
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logSkippedLogArchiveDirectory(
  absolutePath: string,
  archivePath: string,
  error: unknown,
): void {
  logger.warn("[export-logs] the log directory is unreadable, skipping it during export", {
    absolutePath,
    archivePath,
    error: formatErrorMessage(error),
  });
}

async function walkLogArchiveDirectory(
  absoluteDir: string,
  relativeDir: string,
  visitedDirs: Set<string>,
  files: LogArchiveFileEntry[],
): Promise<void> {
  const resolvedDir = await realpath(absoluteDir).catch(() => absoluteDir);
  if (visitedDirs.has(resolvedDir)) {
    return;
  }
  visitedDirs.add(resolvedDir);

  const dirents = await readdir(absoluteDir, { withFileTypes: true }).catch((error: unknown) => {
    // Log sources under the user directory may contain subdirectories with restricted permissions by the system or third-party CLI.
    // When a single directory scandir fails, the directory will be skipped to avoid interrupting the export of the entire log package by EACCES.
    logSkippedLogArchiveDirectory(absoluteDir, relativeDir, error);
    return null;
  });
  if (!dirents) {
    return;
  }
  dirents.sort((left, right) => left.name.localeCompare(right.name));

  for (const dirent of dirents) {
    const archivePath = relativeDir ? posix.join(relativeDir, dirent.name) : dirent.name;
    if (isExcludedRelativePath(archivePath)) {
      continue;
    }

    const absolutePath = join(absoluteDir, dirent.name);
    if (dirent.isDirectory()) {
      await walkLogArchiveDirectory(absolutePath, archivePath, visitedDirs, files);
      continue;
    }

    if (dirent.isFile()) {
      files.push({ absolutePath, archivePath });
      continue;
    }

    if (!dirent.isSymbolicLink()) {
      continue;
    }

    const targetStats = await stat(absolutePath).catch(() => null);
    if (!targetStats) {
      continue;
    }

    // There is a soft link entry for provider shared resources in the log directory.
    // This is processed according to the target type and combined with realpath deduplication to avoid repeatedly packaging the same content during recursive follow-up, or even forming a loop traversal.
    if (targetStats.isDirectory()) {
      await walkLogArchiveDirectory(absolutePath, archivePath, visitedDirs, files);
      continue;
    }

    if (targetStats.isFile()) {
      files.push({ absolutePath, archivePath });
    }
  }
}

async function collectLogArchiveFilesFromDirectory(
  absoluteDir: string,
  relativeDir: string,
  visitedDirs: Set<string>,
  files: LogArchiveFileEntry[],
): Promise<void> {
  const directoryStats = await stat(absoluteDir).catch(() => null);
  if (!directoryStats?.isDirectory()) {
    return;
  }

  await walkLogArchiveDirectory(absoluteDir, relativeDir, visitedDirs, files);
}

/**
 * Collect single-level directories by file name whitelist, without recursion. Used for scenarios such as "diagnostic files and credentials are placed together" in the running directory:
 * Recursive collection will bring secrets such as .tokens into the log packet that the user will forward, and the EXCLUDED list is
 * Remedial after the fact, natural lag. The whitelist is rejected by default - nothing more in the directory will be leaked out in the future.
 */
async function collectLogArchiveFilesByName(
  absoluteDir: string,
  relativeDir: string,
  isCollectableFileName: (fileName: string) => boolean,
  files: LogArchiveFileEntry[],
): Promise<void> {
  const dirents = await readdir(absoluteDir, { withFileTypes: true }).catch(() => null);
  if (!dirents) {
    return;
  }
  dirents.sort((left, right) => left.name.localeCompare(right.name));
  for (const dirent of dirents) {
    if (!dirent.isFile() || !isCollectableFileName(dirent.name)) {
      continue;
    }
    await collectLogArchiveFile(
      join(absoluteDir, dirent.name),
      posix.join(relativeDir, dirent.name),
      files,
    );
  }
}

async function collectLogArchiveFile(
  absolutePath: string,
  archivePath: string,
  files: LogArchiveFileEntry[],
): Promise<void> {
  if (isExcludedRelativePath(archivePath)) {
    return;
  }
  const fileStats = await stat(absolutePath).catch(() => null);
  if (!fileStats?.isFile()) {
    return;
  }
  files.push({ absolutePath, archivePath });
}

async function collectLogArchiveFiles(sourceDir: string): Promise<LogArchiveFileEntry[]> {
  const files: LogArchiveFileEntry[] = [];
  const visitedDirs = new Set<string>();
  await collectLogArchiveFilesFromDirectory(sourceDir, "", visitedDirs, files);
  files.sort((left, right) => left.archivePath.localeCompare(right.archivePath));
  return files;
}

async function createLogArchiveArtifacts(
  sourceDir: string,
  options: CreateLogArchiveArtifactsOptions = {},
): Promise<LogArchiveArtifacts> {
  const files: LogArchiveFileEntry[] = [];
  const visitedDirs = new Set<string>();

  await collectLogArchiveFilesFromDirectory(sourceDir, "", visitedDirs, files);

  const zcodeCliLogDir = getZCodeCliLogDir();
  // The running log of GLM/zcode-cli is written in ~/.zcode/cli/log, not in the application main data directory ~/.zcode/v2.
  // If the exported logs only scan v2, the most critical native-side logs will be missing when locating agent CLI startup, protocol, or crash issues.
  await collectLogArchiveFilesFromDirectory(
    zcodeCliLogDir,
    posix.join(".zcode", "cli", "log"),
    visitedDirs,
    files,
  );

  const zcodeCliDir = getZCodeCliDir();
  // Troubleshooting agent CLI issues also requires its running configuration and model IO trace.
  // config.json is the current effective configuration; rollout is the model-io calling trace.
  // Both are not under ~/.zcode/cli/log, and additional collection is required to fully restore the scene.
  await collectLogArchiveFile(
    join(zcodeCliDir, "config.json"),
    posix.join(".zcode", "cli", "config.json"),
    files,
  );
  await collectLogArchiveFilesFromDirectory(
    join(zcodeCliDir, "rollout"),
    posix.join(".zcode", "cli", "rollout"),
    visitedDirs,
    files,
  );

  // The structured diagnosis of Computer Use Helper must be included in the log package: otherwise it will be included in the feedback package
  // grep "background keyboard begin rejected" hits 0,
  // Because the Helper is started by LaunchServices and stderr is discarded by the system, it sets the diagnostic tee to
  // ~/.zcode/computer-use/run/<socket>.exit.log, neither under app data nor ~/.zcode/cli.
  // There are .tokens broker credentials in the same directory, so only *.exit.log is included in the whitelist by file name, and the directory is not recursed.
  await collectLogArchiveFilesByName(
    getCuaHelperRunDir(),
    posix.join(".zcode", "computer-use", "run"),
    isCuaHelperDiagnosticFileName,
    files,
  );

  const recentFiles = await filterRecentLogArchiveFiles(files, options);
  recentFiles.sort((left, right) => left.archivePath.localeCompare(right.archivePath));

  return {
    files: recentFiles,
    aboutContent: createAboutContent(),
  };
}

async function copyLogArchiveFilesToDirectory(
  outputPath: string,
  files: LogArchiveFileEntry[],
): Promise<LogArchiveSkippedFileEntry[]> {
  const skippedFiles: LogArchiveSkippedFileEntry[] = [];

  for (const file of files) {
    const destinationPath = join(outputPath, ...file.archivePath.split("/"));
    await mkdir(dirname(destinationPath), { recursive: true });

    const sourceStats = await stat(file.absolutePath).catch((error: unknown) => {
      skippedFiles.push({
        absolutePath: file.absolutePath,
        archivePath: file.archivePath,
        error: formatErrorMessage(error),
      });
      return null;
    });
    if (!sourceStats?.isFile()) {
      continue;
    }

    const sourceReadable = await access(file.absolutePath, constants.R_OK)
      .then(() => true)
      .catch((error: unknown) => {
        skippedFiles.push({
          absolutePath: file.absolutePath,
          archivePath: file.archivePath,
          error: formatErrorMessage(error),
        });
        return false;
      });
    if (!sourceReadable) {
      continue;
    }

    try {
      // This is changed to "sampling recognition encoding + streaming desensitization" to avoid large file memory peaks caused by full readFile.
      // At the same time, UTF-16 text (common forms with BOM/no BOM) is explicitly supported to prevent sensitive fields from being leaked as they are after being misjudged as binary.
      const sourceSample = await readFileSample(file.absolutePath);
      const textEncodingInfo = detectTextFileEncoding(sourceSample);
      if (!textEncodingInfo) {
        await copyFile(file.absolutePath, destinationPath);
      } else {
        await sanitizeTextLogFileToDestination(
          file.absolutePath,
          destinationPath,
          textEncodingInfo,
        );
      }
    } catch (error) {
      const sourceStatsAfterFailure = await stat(file.absolutePath).catch(() => null);
      const sourceReadableAfterFailure = sourceStatsAfterFailure?.isFile()
        ? await access(file.absolutePath, constants.R_OK)
            .then(() => true)
            .catch(() => false)
        : false;
      // The telemetry/agent log file may be rotated, deleted or have permissions changed in the background after "scanning the list to be exported".
      // Soft link targets may also fail during this window. After copying fails, check the readability of the source file again;
      // If the source is no longer readable, skip it as a bad file to prevent a single ENOENT/EACCES from causing the entire export to fail.
      if (!sourceReadableAfterFailure) {
        skippedFiles.push({
          absolutePath: file.absolutePath,
          archivePath: file.archivePath,
          error: formatErrorMessage(error),
        });
        continue;
      }
      throw error;
    }
  }

  return skippedFiles;
}

function logSkippedLogArchiveFiles(skippedFiles: LogArchiveSkippedFileEntry[]): void {
  if (skippedFiles.length === 0) {
    return;
  }

  logger.warn("[export-logs] unreadable log files were detected, skipping them during export", {
    skippedCount: skippedFiles.length,
    skippedFiles: skippedFiles.slice(0, 10),
  });
}

async function writeLogArchiveZip(
  outputPath: string,
  artifacts: LogArchiveArtifacts,
  options: WriteLogArchiveZipOptions = {},
): Promise<void> {
  const stageRootDir = options.stageRootDir ?? getDefaultExportLogStageDir();
  await mkdir(stageRootDir, { recursive: true });
  const stagingDir = await mkdtemp(join(stageRootDir, "stage-"));
  try {
    // yazl.addFile internally executes fs.stat/createReadStream on the source path again.
    // For soft chain targets or telemetry files being rotated, this step may still throw errors asynchronously and trigger unlistened error events.
    // Here, the readable files are stably copied to the temporary directory, and then compressed from the temporary directory to ensure that the zip stage only faces regular files controlled by ourselves.
    await writeLogArchiveDirectory(stagingDir, artifacts);

    const zipFile = new ZipFile();
    const stageFiles = await collectLogArchiveFiles(stagingDir);
    const outputStream = createWriteStream(outputPath);
    zipFile.once("error", (error) => {
      outputStream.destroy(error instanceof Error ? error : new Error(String(error)));
    });

    for (const file of stageFiles) {
      zipFile.addFile(file.absolutePath, file.archivePath);
    }

    const writePromise = pipeline(zipFile.outputStream, outputStream);
    zipFile.end();
    await writePromise;
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function writeLogArchiveDirectory(
  outputPath: string,
  artifacts: LogArchiveArtifacts,
): Promise<void> {
  await mkdir(outputPath, { recursive: true });
  const skippedFiles = await copyLogArchiveFilesToDirectory(outputPath, artifacts.files);
  logSkippedLogArchiveFiles(skippedFiles);

  await writeFile(join(outputPath, "about.txt"), artifacts.aboutContent, "utf-8");
}

export async function createFeedbackLogArchiveFromExportLogs(
  sourceDir: string,
  options: CreateFeedbackLogArchiveFromExportLogsOptions = {},
): Promise<{ path: string; size: number }> {
  return createFeedbackDiagnosticArchive({
    sources: [
      { directory: join(sourceDir, "logs"), archivePrefix: "logs" },
      { directory: getZCodeCliLogDir(), archivePrefix: ".zcode/cli/log" },
      {
        directory: getCuaHelperRunDir(),
        archivePrefix: ".zcode/computer-use/run",
        exitLogsOnly: true,
      },
    ],
    outputRootDir: options.outputRootDir ?? getDefaultFeedbackLogArchiveDir(),
    now: options.now,
    onProgress: options.onProgress,
  });
}

export async function exportLogs(
  dependencies: ExportLogsDependencies = {},
): Promise<{ success: boolean; path?: string; error?: string }> {
  try {
    const now = dependencies.now ?? (() => new Date());
    const getSourceDir = dependencies.getZCodeDataDir ?? getZCodeDataDir;
    const buildArtifacts = dependencies.createLogArchiveArtifacts ?? createLogArchiveArtifacts;
    const writeZip = dependencies.writeLogArchiveZip ?? writeLogArchiveZip;
    const writeDirectory = dependencies.writeLogArchiveDirectory ?? writeLogArchiveDirectory;
    const showItemInFolder =
      dependencies.showItemInFolder ??
      (async (path: string) => {
        const { shell } = await import("electron");
        shell.showItemInFolder(path);
      });
    const getStageRootDir = dependencies.getExportLogStageDir ?? getDefaultExportLogStageDir;
    const getOutputRootDir = dependencies.getExportLogDir ?? getDefaultExportLogDir;

    const sourceDir = getSourceDir();
    const timestamp = formatTimestamp(now());
    const exportBaseName = `zcode-logs-${timestamp}`;
    const outputRootDir = getOutputRootDir();
    await mkdir(outputRootDir, { recursive: true });
    const outputDir = await mkdtemp(join(outputRootDir, `${exportBaseName}-`));
    const zipPath = join(outputDir, `${exportBaseName}.zip`);
    const directoryPath = join(outputDir, exportBaseName);

    logger.info("[export-logs] starting to package the logs", {
      source: sourceDir,
      zipDest: zipPath,
      directoryDest: directoryPath,
    });
    const artifacts = await buildArtifacts(sourceDir, { now });

    try {
      await writeZip(zipPath, artifacts, { stageRootDir: getStageRootDir() });
      await showItemInFolder(zipPath);

      logger.info("[export-logs] log export completed", {
        path: zipPath,
        format: "zip",
      });
      return { success: true, path: zipPath };
    } catch (zipError) {
      const zipErrorMessage = zipError instanceof Error ? zipError.message : String(zipError);

      // The compression capabilities of Windows no longer rely on PowerShell/.NET, but archive writing may still be interrupted by external factors such as antivirus and disk policies.
      // The fallback here is directory export to ensure that users can at least get the original log stably instead of reporting an error directly.
      logger.warn("[export-logs] zip export failed, falling back to directory export", {
        error: zipErrorMessage,
        zipPath,
        fallbackPath: directoryPath,
      });
      await rm(zipPath, { force: true }).catch(() => {});

      try {
        await writeDirectory(directoryPath, artifacts);
      } catch (directoryError) {
        const directoryErrorMessage =
          directoryError instanceof Error ? directoryError.message : String(directoryError);
        throw new Error(
          `zip export failed: ${zipErrorMessage}; directory export failed: ${directoryErrorMessage}`,
        );
      }

      await showItemInFolder(directoryPath);
      logger.info("[export-logs] log export completed", {
        path: directoryPath,
        format: "directory",
      });
      return { success: true, path: directoryPath };
    }
  } catch (err) {
    const message = formatErrorMessage(err);
    logger.error("[export-logs] log export failed", { error: message });
    return { success: false, error: message };
  }
}
